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
	it("splits both assets into equal executions within the chunk (flat breaker load), plus a margin for skipped executions", () => {
		const plan = planChunks(
			[usdt(1_987_749_061_044n), usdc(1_990_063_021_004n)],
			50_000_000_000n,
			600,
			4,
		)
		assert.equal(plan.needed, 40)
		assert.equal(plan.extra, 4)
		assert.equal(plan.scheduled, 44)
		for (const amount of plan.perExecution) assert.ok(amount <= 50_000_000_000n)
		plan.assets.forEach((asset, position) => {
			const moved = (plan.perExecution[position] ?? 0n) * BigInt(plan.needed)
			assert.equal(moved + (plan.dust[position] ?? 0n), asset.amount)
			assert.ok((plan.dust[position] ?? 0n) < BigInt(plan.needed))
		})
		assert.equal(plan.intervalBlocks, 600)
		assert.equal(neededDurationBlocks(plan), 600 * 40)
		assert.equal(totalDurationBlocks(plan), 600 * 44)
	})

	it("needs one execution when the balance fits one chunk, so no periodic schedule is created", () => {
		const plan = planChunks([usdt(4_000_000n), usdc(0n)], 50_000_000_000n, 600)
		assert.equal(plan.needed, 1)
		assert.equal(plan.scheduled, 1)
		assert.deepEqual(plan.perExecution, [4_000_000n, 0n])
		assert.deepEqual(plan.dust, [0n, 0n])
	})

	it("sizes the execution count by the larger asset so both assets drain in the same executions", () => {
		const plan = planChunks([usdt(100_000_000_000n), usdc(1_000_000n)], 30_000_000_000n, 10, 1)
		assert.equal(plan.needed, 4)
		assert.equal(plan.scheduled, 5)
		assert.deepEqual(plan.perExecution, [25_000_000_000n, 250_000n])
	})

	it("rejects a zero sweep and an invalid chunk, interval or margin, so a no-op schedule cannot be built", () => {
		assert.throws(() => planChunks([usdt(0n), usdc(0n)], 1n, 1), /Nothing to sweep/)
		assert.throws(() => planChunks([usdt(1n)], 0n, 1), /chunk/)
		assert.throws(() => planChunks([usdt(1n)], 1n, 0), /intervalBlocks/)
		assert.throws(() => planChunks([usdt(1n)], 1n, 1, -1), /extra/)
	})
})

describe("chunkForFootprint", () => {
	const assets = [usdt(1_987_749_061_044n), usdc(1_990_063_021_004n)]
	const hour = 3_600_000
	it("caps the peak accumulator load at the target share of the egress limit, without rounding the chunk needlessly small", () => {
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
			const bigger = planChunks(assets, chunk + 1_000_000n, 600)
			assert.ok(accumulatorLoad(bigger, intervalMs, 6 * hour).peak > share * limitUnits * 0.98)
		}
	})
	it("derives the analytical chunk for the live parameters (710k limit, 15%, hourly): 0.15 * 710k * (1 - e^(-1/6)) split by asset share, rounded down to whole tokens", () => {
		const chunk = chunkForFootprint(assets, {
			limitUnits: 710_000_000_000,
			share: 0.15,
			intervalMs: hour,
			windowMs: 6 * hour,
		})
		assert.equal(chunk, 8_179_000_000n)
	})
	it("rejects a zero egress limit because no chunk can satisfy the footprint", () => {
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
