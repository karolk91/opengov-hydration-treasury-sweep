import assert from "node:assert/strict"
import { before, describe, it } from "node:test"
import { parseAccount, siblingSovereignAccount, toSs58 } from "./accounts.ts"
import { getOfflineApis, type OfflineApis } from "./chains.ts"
import { DEFAULT_HOLDER, EXPECTED_ASSET_HUB_TREASURY, HYDRATION_SS58_PREFIX } from "./config.ts"
import { planChunks } from "./plan.ts"
import { buildProposal, type SweepParams, schedulerTaskId } from "./proposal.ts"

const usdt = (amount: bigint) =>
	({ symbol: "USDT", hydrationAssetId: 10, assetHubAssetId: 1984n, decimals: 6, amount }) as const
const usdc = (amount: bigint) =>
	({ symbol: "USDC", hydrationAssetId: 22, assetHubAssetId: 1337n, decimals: 6, amount }) as const

type BatchCalls = { calls: Array<{ type: string; value: { type: string; value: unknown } }> }
type TransferArgs = {
	call: {
		value: {
			value: {
				currencies: Array<[number, bigint]>
				fee_item: number
				dest: { value: { interior: { value: Array<{ type: string; value: unknown }> } } }
			}
		}
	}
}

describe("buildProposal", () => {
	let apis: OfflineApis
	let params: SweepParams
	before(async () => {
		apis = await getOfflineApis()
		const sovereignKey = siblingSovereignAccount(1000)
		params = {
			holder: DEFAULT_HOLDER,
			sovereign: { ss58: toSs58(sovereignKey, HYDRATION_SS58_PREFIX), publicKey: sovereignKey },
			beneficiary: parseAccount(EXPECTED_ASSET_HUB_TREASURY),
			plan: planChunks([usdt(120_000_000_000n), usdc(90_000_000_000n)], 50_000_000_000n, 600, 2),
			feeBudget: 200_000_000n,
			topUp: { dotAssetId: 5, amount: 5_000_000_000n },
			priority: 0,
			fallbackMaxWeight: { ref_time: 2_000_000_000n, proof_size: 10_000n },
		}
	})

	it("batches the top-up and one periodic task covering needed + extra executions", () => {
		const proposal = buildProposal(apis, params)
		assert.equal(proposal.call.decodedCall.type, "Utility")
		assert.equal(proposal.call.decodedCall.value.type, "batch_all")
		const { calls } = proposal.call.decodedCall.value.value as BatchCalls
		assert.deepEqual(
			calls.map((call) => `${call.type}.${call.value.type}`),
			["PolkadotXcm.send", "Scheduler.schedule_named_after"],
		)
		// ceil(120,000 / 50,000) = 3 needed + 2 extra = 5 executions, every 600 blocks.
		assert.equal(proposal.periodic.count, 5)
		assert.equal(proposal.periodic.firstAfter, 600)
		assert.equal(proposal.periodic.every, 600)
		const scheduled = calls[1]?.value.value as {
			id: string
			after: number
			maybe_periodic?: [number, number]
			priority: number
		}
		assert.equal(scheduled.id, schedulerTaskId())
		assert.equal(scheduled.id, proposal.periodic.taskId)
		assert.match(scheduled.id, /^0x[0-9a-f]{64}$/)
		// Scheduler.cancel_named(id) is offered as the emergency stop.
		assert.equal(proposal.cancel.decodedCall.type, "Scheduler")
		assert.equal(proposal.cancel.decodedCall.value.type, "cancel_named")
		assert.equal((proposal.cancel.decodedCall.value.value as { id: string }).id, scheduled.id)
		assert.equal(scheduled.after, 600)
		assert.deepEqual(scheduled.maybe_periodic, [600, 5])
		assert.equal(scheduled.priority, 0)
	})

	it("moves equal chunks to the beneficiary, paying Asset Hub fees with the larger leg", () => {
		const proposal = buildProposal(apis, params)
		const transfer = (proposal.periodic.hydrationCall.decodedCall.value.value as TransferArgs).call
			.value.value
		assert.deepEqual(transfer.currencies, [
			[10, 40_000_000_000n],
			[22, 30_000_000_000n],
		])
		assert.equal(transfer.fee_item, 0)
		const [, account] = transfer.dest.value.interior.value
		assert.deepEqual(account, {
			type: "AccountId32",
			value: {
				network: undefined,
				id: "0x6d6f646c70792f74727372790000000000000000000000000000000000000000",
			},
		})
		// Both legs are paid Transacts refunded to the sovereign account.
		for (const leg of [proposal.topUp, proposal.periodic]) {
			assert.ok(leg)
			assert.equal(leg.instructions.length, 5)
			assert.equal(leg.instructions[2]?.type, "Transact")
		}
	})

	it("omits the top-up when not requested and the periodicity for a single execution", () => {
		const proposal = buildProposal(apis, {
			...params,
			topUp: undefined,
			plan: planChunks([usdt(100_000_000_000n), usdc(0n)], 100_000_000_000n, 600, 0),
		})
		assert.equal(proposal.topUp, undefined)
		assert.equal(proposal.periodic.count, 1)
		const { calls } = proposal.call.decodedCall.value.value as BatchCalls
		assert.equal(calls.length, 1)
		const [only] = calls
		assert.ok(only)
		assert.equal((only.value.value as { maybe_periodic?: unknown }).maybe_periodic, undefined)
	})
})
