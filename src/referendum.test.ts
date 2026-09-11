import assert from "node:assert/strict"
import { before, describe, it } from "node:test"
import { TraitsScheduleDispatchTime } from "@polkadot-api/descriptors"
import { toHex } from "polkadot-api/utils"
import { getOfflineApis, type OfflineAssetHubApi, type OfflineCollectivesApi } from "./chains.ts"
import { INLINE_PREIMAGE_LIMIT } from "./config.ts"
import { toBytes } from "./hex.ts"
import { buildReferendumCalls, callHash, type EncodedCall } from "./referendum.ts"

const REMARK_PROPOSAL = "0x00004c6f70656e676f762d7375626d69742074657374"
const REMARK_HASH = "0x8821e8db19b8e34b62ee8bc618a5ed3eecb9761d7d81349b00aa5ce5dfca2534"

describe("buildReferendumCalls", () => {
	let assetHub: OfflineAssetHubApi
	let collectives: OfflineCollectivesApi
	let proposal: EncodedCall

	before(async () => {
		;({ assetHub, collectives } = await getOfflineApis())
		proposal = assetHub.tx.System.remark({
			remark: new TextEncoder().encode("opengov-submit test"),
		})
		assert.equal(toHex(proposal.encodedData), REMARK_PROPOSAL)
		assert.equal(callHash(proposal.encodedData), REMARK_HASH)
	})

	it("encodes the Root track byte-for-byte like opengov-cli, so the calls are interchangeable with the reference tool", () => {
		const calls = buildReferendumCalls(
			{ assetHub, collectives },
			proposal,
			"root",
			TraitsScheduleDispatchTime.After(10),
		)
		assert.equal(calls.fellowshipReferendumSubmission, undefined)
		assert.equal(calls.preimageForWhitelistCall, undefined)
		assert.equal(
			toHex(calls.preimageForPublicReferendum.encodedData),
			"0x05005800004c6f70656e676f762d7375626d69742074657374",
		)
		assert.equal(
			toHex(calls.publicReferendumSubmission.encodedData),
			"0x3e000000028821e8db19b8e34b62ee8bc618a5ed3eecb9761d7d81349b00aa5ce5dfca253416000000010a000000",
		)
		assert.equal(calls.batches.length, 1)
		assert.equal(calls.batches[0]?.chain, "ahp")
		assert.equal(
			toHex(calls.batches[0]?.encodedData ?? new Uint8Array()),
			`0x2804${"08"}${"05005800004c6f70656e676f762d7375626d69742074657374"}${"3e000000028821e8db19b8e34b62ee8bc618a5ed3eecb9761d7d81349b00aa5ce5dfca253416000000010a000000"}`,
		)
	})

	it("encodes the Whitelisted Caller track byte-for-byte like opengov-cli, including the Fellowship whitelist referendum", () => {
		const calls = buildReferendumCalls(
			{ assetHub, collectives },
			proposal,
			"whitelisted-caller",
			TraitsScheduleDispatchTime.After(10),
		)
		assert.equal(calls.preimageForWhitelistCall, undefined)
		assert.equal(calls.fellowshipReferendumSubmission?.chain, "collectives")
		assert.equal(
			toHex(calls.fellowshipReferendumSubmission?.encodedData ?? new Uint8Array()),
			"0x3d003e0201cc1f0005010100a10f05082f00000603008840008821e8db19b8e34b62ee8bc618a5ed3eecb9761d7d81349b00aa5ce5dfca2534010a000000",
		)
		assert.equal(
			toHex(calls.preimageForPublicReferendum.encodedData),
			"0x050060400300004c6f70656e676f762d7375626d69742074657374",
		)
		assert.equal(
			toHex(calls.publicReferendumSubmission.encodedData),
			"0x3e003f0d02a322f65fd03ba368587f997b14e306211f6fb3c30b06a5be472f2f96b3b27e1e18000000010a000000",
		)
		assert.deepEqual(
			calls.batches.map((batch) => batch.chain),
			["collectives", "ahp"],
		)
	})

	it("inlines the Fellowship proposal because the whitelist wrapper is a fixed-size hash below the inline limit, so Collectives needs no preimage", () => {
		const calls = buildReferendumCalls(
			{ assetHub, collectives },
			proposal,
			"whitelisted-caller",
			TraitsScheduleDispatchTime.At(1),
		)
		const submission = calls.fellowshipReferendumSubmission?.decodedCall.value.value as {
			proposal: { type: string; value: unknown }
		}
		assert.equal(submission.proposal.type, "Inline")
		assert.ok(toBytes(submission.proposal.value).length <= INLINE_PREIMAGE_LIMIT)
		assert.equal(calls.preimageForWhitelistCall, undefined)
	})
})
