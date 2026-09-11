import type { StablecoinSymbol } from "./config.ts"

export interface AssetAmount {
	readonly symbol: StablecoinSymbol
	readonly hydrationAssetId: number
	readonly assetHubAssetId: bigint
	readonly decimals: number
	readonly amount: bigint
}

export interface ChunkPlan {
	readonly assets: readonly AssetAmount[]
	readonly perExecution: readonly bigint[]
	readonly needed: number
	readonly extra: number
	readonly scheduled: number
	readonly intervalBlocks: number
	readonly dust: readonly bigint[]
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
	return (numerator + denominator - 1n) / denominator
}

export function planChunks(
	assets: readonly AssetAmount[],
	chunk: bigint,
	intervalBlocks: number,
	extra = 0,
): ChunkPlan {
	if (chunk <= 0n) throw new Error("chunk must be positive")
	if (!Number.isInteger(intervalBlocks) || intervalBlocks <= 0) {
		throw new Error("intervalBlocks must be a positive integer")
	}
	if (!Number.isInteger(extra) || extra < 0) throw new Error("extra must be a non-negative integer")
	const totals = assets.map((asset) => asset.amount)
	const largest = totals.reduce((max, amount) => (amount > max ? amount : max), 0n)
	if (largest <= 0n) throw new Error("Nothing to sweep: all balances are zero")
	const needed = Number(ceilDiv(largest, chunk))
	const perExecution = totals.map((total) => total / BigInt(needed))
	const dust = totals.map(
		(total, position) => total - (perExecution[position] ?? 0n) * BigInt(needed),
	)
	return {
		assets,
		perExecution,
		needed,
		extra,
		scheduled: needed + extra,
		intervalBlocks,
		dust,
	}
}

export function neededDurationBlocks(plan: ChunkPlan): number {
	return plan.intervalBlocks * plan.needed
}

export function totalDurationBlocks(plan: ChunkPlan): number {
	return plan.intervalBlocks * plan.scheduled
}

export interface FootprintTarget {
	readonly limitUnits: number
	readonly share: number
	readonly intervalMs: number
	readonly windowMs: number
}

export function chunkForFootprint(assets: readonly AssetAmount[], target: FootprintTarget): bigint {
	const totals = assets.map((asset) => Number(asset.amount))
	const sum = totals.reduce((runningSum, total) => runningSum + total, 0)
	const largest = Math.max(...totals)
	if (sum <= 0 || target.limitUnits <= 0 || target.share <= 0)
		throw new Error("invalid footprint target")
	const perExecution =
		target.share * target.limitUnits * (1 - Math.exp(-target.intervalMs / target.windowMs))
	const forLargest = (perExecution * largest) / sum
	const wholeTokenUnits = 1_000_000
	return BigInt(Math.max(1, Math.floor(forLargest / wholeTokenUnits))) * BigInt(wholeTokenUnits)
}

export function accumulatorLoad(
	plan: ChunkPlan,
	intervalMs: number,
	windowMs: number,
): { perExecution: number; perWindow: number; peak: number; trough: number } {
	const perExecution = Number(plan.perExecution.reduce((sum, amount) => sum + amount, 0n))
	const peak = perExecution / (1 - Math.exp(-intervalMs / windowMs))
	return {
		perExecution,
		perWindow: perExecution * (windowMs / intervalMs),
		peak,
		trough: peak - perExecution,
	}
}
