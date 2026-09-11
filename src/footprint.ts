import type { XcmVersionedXcm } from "@polkadot-api/descriptors"
import type { HydrationApi } from "./chains.ts"
import { formatUnits } from "./format.ts"
import { type CircuitBreakerState, getCircuitBreakerState, quoteXcmFees } from "./hydration.ts"
import { accumulatorLoad, type ChunkPlan } from "./plan.ts"
import { assetHubAssetLocation, DOT_LOCATION, type Weight, type XcmLocation } from "./xcm.ts"

/** HDX on Hydration (the native token, GeneralIndex 0), as an XCM fee-payment location. */
const HDX_LOCATION: XcmLocation = {
	parents: 0,
	interior: { type: "X1", value: { type: "GeneralIndex", value: 0n } },
}

export interface SweepEconomics {
	/** Weight of one sweep message, for fee reporting and the v4 `fallbackMaxWeight`. */
	readonly weight: Weight
	/** Per-execution fee for one sweep message in each of DOT / HDX / USDT (raw units), or `undefined` if unpriced. */
	readonly fees: ReadonlyMap<string, bigint | undefined>
	/** USDT per 1 HDX, implied by the fee quote (the message weighs the same in each asset). */
	readonly usdtPerHdx: number | undefined
	readonly breaker: CircuitBreakerState | undefined
	/** Hydration's egress limit in the stablecoins' units (HDX limit x price), or `undefined` if unavailable. */
	readonly limitUnits: number | undefined
	readonly windowMs: number | undefined
}

/**
 * Price one sweep message in DOT / HDX / USDT and read Hydration's egress circuit breaker, converting
 * its HDX-denominated limit into the stablecoins' units via the HDX price the quote implies. Shared by
 * the #1501 sweep generator and the #1729 combined-referendum builder to size the sweep chunk and
 * report fees. The message's weight is independent of the amounts, so any draft prices it correctly.
 */
export async function quoteSweepEconomics(
	api: HydrationApi,
	sweepMessage: XcmVersionedXcm,
	usdtAssetHubId: bigint,
): Promise<SweepEconomics> {
	const feeAssets = new Map<string, XcmLocation>([
		["DOT", DOT_LOCATION],
		["HDX", HDX_LOCATION],
		["USDT", assetHubAssetLocation(usdtAssetHubId, "sibling")],
	])
	const { weight, fees } = await quoteXcmFees(api, sweepMessage, feeAssets)
	const feeHdx = fees.get("HDX")
	const feeUsdt = fees.get("USDT")
	const usdtPerHdx = feeHdx && feeUsdt && feeHdx > 0n ? Number(feeUsdt) / Number(feeHdx) : undefined
	const breaker = await getCircuitBreakerState(api)
	const limitUnits =
		breaker && usdtPerHdx !== undefined ? Number(breaker.limit) * usdtPerHdx : undefined
	const windowMs = breaker ? Number(breaker.windowMs) : undefined
	return { weight, fees, usdtPerHdx, breaker, limitUnits, windowMs }
}

/**
 * Human-readable lines describing a plan's steady-state load on Hydration's egress accumulator as a
 * share of the (stablecoin-denominated) limit, including a peak-over-target warning and the HDX-price
 * caveat. `limitUnits` and the plan's totals are in the same 6-dp units.
 */
export function describeFootprint(
	plan: ChunkPlan,
	limitUnits: number,
	windowMs: number,
	intervalMs: number,
	maxFootprint: number,
): string[] {
	const load = accumulatorLoad(plan, intervalMs, windowMs)
	const pct = (v: number) => `${((100 * v) / limitUnits).toFixed(1)}%`
	const usd = (v: number) => formatUnits(BigInt(Math.round(v)), 6, "USD")
	const lines = [
		`our footprint: ${usd(load.perExecution)} per execution (${pct(load.perExecution)}); ~${usd(load.perWindow)} per ${windowMs / 3_600_000}h window (${pct(load.perWindow)}); accumulator load between ~${pct(load.trough)} and ~${pct(load.peak)}`,
	]
	if (load.peak / limitUnits > maxFootprint + 1e-9) {
		lines.push(
			`warning: peak load exceeds ${(maxFootprint * 100).toFixed(0)}% of the egress limit; use a smaller chunk or a longer interval`,
		)
	}
	lines.push(
		"note: the limit is denominated in HDX, so a lower HDX price during the sweep raises our share proportionally",
	)
	return lines
}
