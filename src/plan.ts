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
	/** Amount per asset moved by every execution (same order as `assets`). */
	readonly perExecution: readonly bigint[]
	/** Executions needed to move the totals: `ceil(largest total / chunk)`. */
	readonly needed: number
	/** Additional executions scheduled as a margin for ones that fail (e.g. no egress headroom). */
	readonly extra: number
	/** Executions actually scheduled (`needed + extra`), every `intervalBlocks`, the first one `intervalBlocks` after enactment. */
	readonly scheduled: number
	readonly intervalBlocks: number
	/** Per asset, what `needed` equal executions cannot move because of integer division (< `needed` raw units). */
	readonly dust: readonly bigint[]
}

function ceilDiv(a: bigint, b: bigint): bigint {
	return (a + b - 1n) / b
}

/**
 * Splits the totals into `needed` identical executions, where `needed` is the smallest number such
 * that no execution moves more than `chunk` of any asset, so the whole sweep is one periodic
 * scheduler task. `extra` more executions of the same size are scheduled as a safety margin: if an
 * execution is skipped (Hydration's egress bucket full at that moment) a later one catches up, and
 * once the holder is empty the surplus executions fail harmlessly inside the proxied call.
 */
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
	const dust = totals.map((total, i) => total - (perExecution[i] ?? 0n) * BigInt(needed))
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

/** Blocks until the last *needed* execution. */
export function neededDurationBlocks(plan: ChunkPlan): number {
	return plan.intervalBlocks * plan.needed
}

/** Blocks until the last *scheduled* execution (including the margin). */
export function totalDurationBlocks(plan: ChunkPlan): number {
	return plan.intervalBlocks * plan.scheduled
}

export interface FootprintTarget {
	/** Egress limit expressed in the swept assets' units (6 decimals). */
	readonly limitUnits: number
	/** Share of the limit our accumulator load may reach at its peak, 0..1. */
	readonly share: number
	readonly intervalMs: number
	readonly windowMs: number
}

/**
 * Largest per-asset chunk such that our steady-state load on Hydration's egress accumulator stays
 * at or below `share` of the limit. Contributions decay like e^(-t/window) (the accumulator is
 * updated constantly), so the load right after an execution converges to
 * `perExecution / (1 - e^(-interval/window))`. The per-execution value is split across the assets
 * in proportion to their totals, and the result is rounded down to whole units of the largest asset.
 */
export function chunkForFootprint(assets: readonly AssetAmount[], target: FootprintTarget): bigint {
	const totals = assets.map((asset) => Number(asset.amount))
	const sum = totals.reduce((a, b) => a + b, 0)
	const largest = Math.max(...totals)
	if (sum <= 0 || target.limitUnits <= 0 || target.share <= 0)
		throw new Error("invalid footprint target")
	const perExecution =
		target.share * target.limitUnits * (1 - Math.exp(-target.intervalMs / target.windowMs))
	const forLargest = (perExecution * largest) / sum
	const unit = 1_000_000 // one whole token of a 6-decimal asset
	const chunk = BigInt(Math.max(1, Math.floor(forLargest / unit))) * BigInt(unit)
	return chunk
}

/** Peak and trough accumulator load (in the assets' units) of a plan, see `chunkForFootprint`. */
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
