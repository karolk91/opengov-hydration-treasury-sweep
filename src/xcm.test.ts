import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ahp } from "@polkadot-api/descriptors"
import { getOfflineApi } from "polkadot-api"
import { toHex } from "polkadot-api/utils"
import { siblingSovereignAccount } from "./accounts.ts"
import { HYDRATION_PARA_ID } from "./config.ts"
import {
	accountId32Location,
	assetHubAssetLocation,
	buildSendToHydration,
	buildTransactXcm,
	DOT_LOCATION,
	fungible,
	HYDRATION_LOCATION,
} from "./xcm.ts"

describe("locations", () => {
	it("expresses Asset Hub assets from both points of view", () => {
		assert.deepEqual(assetHubAssetLocation(1984n, "asset-hub"), {
			parents: 0,
			interior: {
				type: "X2",
				value: [
					{ type: "PalletInstance", value: 50 },
					{ type: "GeneralIndex", value: 1984n },
				],
			},
		})
		assert.deepEqual(assetHubAssetLocation(1337n, "sibling"), {
			parents: 1,
			interior: {
				type: "X3",
				value: [
					{ type: "Parachain", value: 1000 },
					{ type: "PalletInstance", value: 50 },
					{ type: "GeneralIndex", value: 1337n },
				],
			},
		})
		assert.deepEqual(HYDRATION_LOCATION, {
			parents: 1,
			interior: { type: "X1", value: { type: "Parachain", value: HYDRATION_PARA_ID } },
		})
		const key = siblingSovereignAccount(1000)
		assert.deepEqual(accountId32Location(key), {
			parents: 0,
			interior: {
				type: "X1",
				value: { type: "AccountId32", value: { network: undefined, id: toHex(key) } },
			},
		})
	})
})

describe("buildTransactXcm", () => {
	const refundTo = siblingSovereignAccount(1000)
	const call = new Uint8Array([0x1d, 0x00, 0x01, 0x02])
	const program = buildTransactXcm({
		feeBudget: 200_000_000n,
		call,
		fallbackMaxWeight: { ref_time: 1_000n, proof_size: 10n },
		refundTo,
	})

	it("withdraws DOT, buys execution, transacts as the sovereign account and refunds the rest", () => {
		assert.deepEqual(
			program.map((instruction) => instruction.type),
			["WithdrawAsset", "BuyExecution", "Transact", "RefundSurplus", "DepositAsset"],
		)
		const [withdraw, buy, transact, , deposit] = program
		if (withdraw?.type !== "WithdrawAsset") throw new Error("unreachable")
		assert.deepEqual(withdraw.value, [fungible(DOT_LOCATION, 200_000_000n)])
		if (buy?.type !== "BuyExecution") throw new Error("unreachable")
		assert.deepEqual(buy.value.fees, fungible(DOT_LOCATION, 200_000_000n))
		assert.equal(buy.value.weight_limit.type, "Unlimited")
		if (transact?.type !== "Transact") throw new Error("unreachable")
		assert.equal(transact.value.origin_kind.type, "SovereignAccount")
		assert.deepEqual(transact.value.fallback_max_weight, { ref_time: 1_000n, proof_size: 10n })
		assert.equal(transact.value.call, call)
		if (deposit?.type !== "DepositAsset") throw new Error("unreachable")
		assert.deepEqual(deposit.value.assets, {
			type: "Wild",
			value: { type: "AllCounted", value: 1 },
		})
		assert.deepEqual(deposit.value.beneficiary, accountId32Location(refundTo))
	})

	it("rejects a zero fee budget", () => {
		assert.throws(() =>
			buildTransactXcm({ feeBudget: 0n, call, fallbackMaxWeight: undefined, refundTo }),
		)
	})
})

describe("buildSendToHydration", () => {
	it("encodes PolkadotXcm.send to ../Parachain(2034) as a v5 message", async () => {
		const assetHub = await getOfflineApi(ahp)
		const send = buildSendToHydration(
			assetHub,
			buildTransactXcm({
				feeBudget: 1n,
				call: new Uint8Array([0x00, 0x00]),
				fallbackMaxWeight: undefined,
				refundTo: siblingSovereignAccount(1000),
			}),
		)
		assert.equal(send.decodedCall.type, "PolkadotXcm")
		assert.equal(send.decodedCall.value.type, "send")
		// pallet 31 / call 0, then VersionedLocation::V5 { parents: 1, X1(Parachain(2034)) }, then VersionedXcm::V5.
		assert.equal(toHex(send.encodedData.slice(0, 9)), "0x1f0005010100c91f05")
	})
})
