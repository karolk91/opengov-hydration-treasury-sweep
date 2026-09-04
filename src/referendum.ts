import {
	GovernanceOrigin,
	PreimagesBounded,
	TraitsScheduleDispatchTime,
	XcmV2OriginKind,
	XcmV3WeightLimit,
	XcmV5Instruction,
	XcmVersionedLocation,
	XcmVersionedXcm,
} from "@polkadot-api/descriptors"
import { Blake2256 } from "@polkadot-api/substrate-bindings"
import type { SizedHex, TxCallData } from "polkadot-api"
import { toHex } from "polkadot-api/utils"
import type { OfflineAssetHubApi, OfflineCollectivesApi } from "./chains.ts"
import { ASSET_HUB_PARA_ID, FELLOWSHIP_ENACTMENT_AFTER, INLINE_PREIMAGE_LIMIT } from "./config.ts"
import { siblingParachainLocation } from "./xcm.ts"

export type Chain = "ahp" | "collectives"
export type Track = "root" | "whitelisted-caller"

export interface EncodedCall {
	readonly encodedData: Uint8Array
	readonly decodedCall: TxCallData
}

/** A call together with the chain it must be submitted on and everything needed to talk about it. */
export interface CallInfo extends EncodedCall {
	readonly chain: Chain
	readonly title: string
	readonly hash: SizedHex<32>
	readonly length: number
}

export interface ReferendumCalls {
	readonly track: Track
	/** The privileged call the referendum will dispatch on Asset Hub. */
	readonly proposal: CallInfo
	/** Whitelisted Caller only: preimage of the Fellowship proposal, if it does not fit `Inline`. */
	readonly preimageForWhitelistCall?: CallInfo
	/** Whitelisted Caller only: the Fellowship referendum (on Collectives) that whitelists the proposal. */
	readonly fellowshipReferendumSubmission?: CallInfo
	/** Preimage of what the public referendum dispatches (the proposal, or its whitelist wrapper). */
	readonly preimageForPublicReferendum: CallInfo
	/** The public referendum submission on Asset Hub. */
	readonly publicReferendumSubmission: CallInfo
	/** One `Utility.force_batch` per chain with every call that has to be signed there. */
	readonly batches: readonly CallInfo[]
}

type AssetHubOriginCaller = Parameters<
	OfflineAssetHubApi["tx"]["Referenda"]["submit"]
>[0]["proposal_origin"]
type CollectivesOriginCaller = Parameters<
	OfflineCollectivesApi["tx"]["FellowshipReferenda"]["submit"]
>[0]["proposal_origin"]

export const ROOT_ORIGIN: AssetHubOriginCaller = {
	type: "system",
	value: { type: "Root", value: undefined },
}
const WHITELISTED_CALLER_ORIGIN: AssetHubOriginCaller = {
	type: "Origins",
	value: GovernanceOrigin.WhitelistedCaller(),
}
const FELLOWS_ORIGIN: CollectivesOriginCaller = {
	type: "FellowshipOrigins",
	value: { type: "Fellows", value: undefined },
}

export function callHash(encodedData: Uint8Array): SizedHex<32> {
	return toHex(Blake2256(encodedData))
}

export function describeCall(chain: Chain, title: string, call: EncodedCall): CallInfo {
	return {
		...call,
		chain,
		title,
		hash: callHash(call.encodedData),
		length: call.encodedData.length,
	}
}

export interface ReferendumBuilders {
	readonly assetHub: OfflineAssetHubApi
	readonly collectives: OfflineCollectivesApi
}

/**
 * Generates every call needed to get `proposal` enacted through OpenGov on Polkadot Asset Hub,
 * following the same recipe as `opengov-cli submit-referendum`:
 *
 * - Root: `Preimage.note_preimage(proposal)` + `Referenda.submit(Root, Lookup(proposal))`.
 * - Whitelisted Caller: a Fellowship referendum on Collectives that sends
 *   `Whitelist.whitelist_call(hash(proposal))` to Asset Hub over XCM, plus the public referendum
 *   dispatching `Whitelist.dispatch_whitelisted_call_with_preimage(proposal)`.
 */
export function buildReferendumCalls(
	apis: ReferendumBuilders,
	proposalCall: EncodedCall,
	track: Track,
	enactment: TraitsScheduleDispatchTime,
): ReferendumCalls {
	const proposal = describeCall("ahp", "Proposal to enact on Polkadot Asset Hub", proposalCall)
	return track === "root"
		? buildRootReferendum(apis.assetHub, proposal, enactment)
		: buildWhitelistedReferendum(apis, proposal, enactment)
}

function buildRootReferendum(
	assetHub: OfflineAssetHubApi,
	proposal: CallInfo,
	enactment: TraitsScheduleDispatchTime,
): ReferendumCalls {
	const preimage = describeCall(
		"ahp",
		"Submit the preimage for the public referendum",
		assetHub.tx.Preimage.note_preimage({ bytes: proposal.encodedData }),
	)
	const submission = describeCall(
		"ahp",
		"Open a public referendum on the Root track",
		assetHub.tx.Referenda.submit({
			proposal_origin: ROOT_ORIGIN,
			proposal: PreimagesBounded.Lookup({ hash: proposal.hash, len: proposal.length }),
			enactment_moment: enactment,
		}),
	)
	return {
		track: "root",
		proposal,
		preimageForPublicReferendum: preimage,
		publicReferendumSubmission: submission,
		batches: [
			batch(assetHub, "ahp", "Batch to submit on Polkadot Asset Hub", [preimage, submission]),
		],
	}
}

function buildWhitelistedReferendum(
	{ assetHub, collectives }: ReferendumBuilders,
	proposal: CallInfo,
	enactment: TraitsScheduleDispatchTime,
): ReferendumCalls {
	// 1. The call the Fellowship needs to execute on Asset Hub.
	const whitelistCall = assetHub.tx.Whitelist.whitelist_call({ call_hash: proposal.hash })

	// 2. Sent from Collectives to Asset Hub over XCM. `OriginKind::Xcm` makes it arrive as the
	//    Fellows plurality, which `Whitelist`'s `WhitelistOrigin` accepts.
	const whitelistOverXcm = describeCall(
		"collectives",
		"Fellowship proposal: whitelist the call on Asset Hub",
		collectives.tx.PolkadotXcm.send({
			dest: XcmVersionedLocation.V5(siblingParachainLocation(ASSET_HUB_PARA_ID)),
			message: XcmVersionedXcm.V5([
				XcmV5Instruction.UnpaidExecution({
					weight_limit: XcmV3WeightLimit.Unlimited(),
					check_origin: undefined,
				}),
				XcmV5Instruction.Transact({
					origin_kind: XcmV2OriginKind.Xcm(),
					fallback_max_weight: undefined,
					call: whitelistCall.encodedData,
				}),
			]),
		}),
	)

	// 3. The Fellowship referendum, inline when small enough, otherwise via a preimage.
	const fellowshipEnactment = TraitsScheduleDispatchTime.After(FELLOWSHIP_ENACTMENT_AFTER)
	const inline = whitelistOverXcm.length <= INLINE_PREIMAGE_LIMIT
	const preimageForWhitelistCall = inline
		? undefined
		: describeCall(
				"collectives",
				"Submit the preimage for the Fellowship referendum",
				collectives.tx.Preimage.note_preimage({ bytes: whitelistOverXcm.encodedData }),
			)
	const fellowshipReferendumSubmission = describeCall(
		"collectives",
		"Open a Fellowship referendum to whitelist the call",
		collectives.tx.FellowshipReferenda.submit({
			proposal_origin: FELLOWS_ORIGIN,
			proposal: inline
				? PreimagesBounded.Inline(whitelistOverXcm.encodedData)
				: PreimagesBounded.Lookup({ hash: whitelistOverXcm.hash, len: whitelistOverXcm.length }),
			enactment_moment: fellowshipEnactment,
		}),
	)

	// 4. The public referendum dispatches the proposal through the whitelist.
	const dispatchWhitelisted = describeCall(
		"ahp",
		"Whitelist dispatch wrapper",
		assetHub.tx.Whitelist.dispatch_whitelisted_call_with_preimage({ call: proposal.decodedCall }),
	)
	const preimageForPublicReferendum = describeCall(
		"ahp",
		"Submit the preimage for the public referendum",
		assetHub.tx.Preimage.note_preimage({ bytes: dispatchWhitelisted.encodedData }),
	)
	const publicReferendumSubmission = describeCall(
		"ahp",
		"Open a public referendum on the Whitelisted Caller track",
		assetHub.tx.Referenda.submit({
			proposal_origin: WHITELISTED_CALLER_ORIGIN,
			proposal: PreimagesBounded.Lookup({
				hash: dispatchWhitelisted.hash,
				len: dispatchWhitelisted.length,
			}),
			enactment_moment: enactment,
		}),
	)

	const collectivesCalls = [preimageForWhitelistCall, fellowshipReferendumSubmission].filter(
		(call): call is CallInfo => call !== undefined,
	)
	return {
		track: "whitelisted-caller",
		proposal,
		...(preimageForWhitelistCall ? { preimageForWhitelistCall } : {}),
		fellowshipReferendumSubmission,
		preimageForPublicReferendum,
		publicReferendumSubmission,
		batches: [
			batch(
				collectives,
				"collectives",
				"Batch to submit on Polkadot Collectives",
				collectivesCalls,
			),
			batch(assetHub, "ahp", "Batch to submit on Polkadot Asset Hub", [
				preimageForPublicReferendum,
				publicReferendumSubmission,
			]),
		],
	}
}

/** `force_batch` so that e.g. an already-noted preimage does not prevent the referendum submission. */
function batch(
	api: OfflineAssetHubApi | OfflineCollectivesApi,
	chain: Chain,
	title: string,
	calls: readonly CallInfo[],
): CallInfo {
	return describeCall(
		chain,
		title,
		api.tx.Utility.force_batch({ calls: calls.map((call) => call.decodedCall) }),
	)
}
