import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
	type AssetAmount,
	accumulatorLoad,
	chunkForFootprint,
	neededDurationBlocks,
	planChunks,
	totalDurationBlocks,
} from "./plan.ts"

const usdt = (amount: bigint): AssetAmount => ({
	symbol: "USDT",
	hydrationAssetId: 10,
	assetHubAssetId: 1984n,
	decimals: 6,
	amount,
})
const usdc = (amount: bigint): AssetAmount => ({
	symbol: "USDC",
	hydrationAssetId: 22,
	assetHubAssetId: 1337n,
	decimals: 6,
	amount,
})

describe("planChunks", () => {
	it("splits both assets into equal executions that fit the chunk and schedules a margin", () => {
		const plan = planChunks(
			[usdt(1_987_749_061_044n), usdc(1_990_063_021_004n)],
			50_000_000_000n,
			600,
			4,
		)
		// ceil(1,990,063 / 50,000) = 40 executions needed, 44 scheduled.
		assert.equal(plan.needed, 40)
		assert.equal(plan.extra, 4)
		assert.equal(plan.scheduled, 44)
		for (const amount of plan.perExecution) assert.ok(amount <= 50_000_000_000n)
		plan.assets.forEach((asset, i) => {
			const moved = (plan.perExecution[i] ?? 0n) * BigInt(plan.needed)
			assert.equal(moved + (plan.dust[i] ?? 0n), asset.amount)
			assert.ok((plan.dust[i] ?? 0n) < BigInt(plan.needed))
		})
		assert.equal(plan.intervalBlocks, 600)
		assert.equal(neededDurationBlocks(plan), 600 * 40)
		assert.equal(totalDurationBlocks(plan), 600 * 44)
	})

	it("uses a single execution when everything fits in one chunk", () => {
		const plan = planChunks([usdt(4_000_000n), usdc(0n)], 50_000_000_000n, 600)
		assert.equal(plan.needed, 1)
		assert.equal(plan.scheduled, 1)
		assert.deepEqual(plan.perExecution, [4_000_000n, 0n])
		assert.deepEqual(plan.dust, [0n, 0n])
	})

	it("handles one asset being much smaller than the other", () => {
		const plan = planChunks([usdt(100_000_000_000n), usdc(1_000_000n)], 30_000_000_000n, 10, 1)
		// ceil(100,000 / 30,000) = 4 executions needed.
		assert.equal(plan.needed, 4)
		assert.equal(plan.scheduled, 5)
		assert.deepEqual(plan.perExecution, [25_000_000_000n, 250_000n])
	})

	it("rejects empty sweeps and bad parameters", () => {
		assert.throws(() => planChunks([usdt(0n), usdc(0n)], 1n, 1), /Nothing to sweep/)
		assert.throws(() => planChunks([usdt(1n)], 0n, 1), /chunk/)
		assert.throws(() => planChunks([usdt(1n)], 1n, 0), /intervalBlocks/)
		assert.throws(() => planChunks([usdt(1n)], 1n, 1, -1), /extra/)
	})
})

describe("chunkForFootprint", () => {
	const assets = [usdt(1_987_749_061_044n), usdc(1_990_063_021_004n)]
	const hour = 3_600_000
	it("keeps the peak accumulator load at or below the target share", () => {
		for (const [limitUnits, share, intervalMs] of [
			[1_089_000_000_000, 0.15, hour],
			[710_000_000_000, 0.15, hour],
			[710_000_000_000, 0.1, 2 * hour],
		] as const) {
			const chunk = chunkForFootprint(assets, { limitUnits, share, intervalMs, windowMs: 6 * hour })
			assert.equal(chunk % 1_000_000n, 0n)
			const plan = planChunks(assets, chunk, 600)
			const load = accumulatorLoad(plan, intervalMs, 6 * hour)
			assert.ok(load.peak <= share * limitUnits, `${load.peak} > ${share * limitUnits}`)
			// and not needlessly small: one more whole token per asset would exceed the target
			const bigger = planChunks(assets, chunk + 1_000_000n, 600)
			assert.ok(accumulatorLoad(bigger, intervalMs, 6 * hour).peak > share * limitUnits * 0.98)
		}
	})
	it("reproduces the analytical numbers for the current situation", () => {
		// $710k limit, 15%, hourly: perExecution = 0.15 * 710k * (1 - e^(-1/6)) = $16,349.67; the larger
		// asset (USDC, 50.03% of the total) gets $8,179.3 -> rounded down to whole tokens.
		const chunk = chunkForFootprint(assets, {
			limitUnits: 710_000_000_000,
			share: 0.15,
			intervalMs: hour,
			windowMs: 6 * hour,
		})
		assert.equal(chunk, 8_179_000_000n)
	})
	it("rejects impossible targets", () => {
		assert.throws(() =>
			chunkForFootprint(assets, {
				limitUnits: 0,
				share: 0.15,
				intervalMs: hour,
				windowMs: 6 * hour,
			}),
		)
	})
})
