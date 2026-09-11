import type { XcmVersionedXcm } from "@polkadot-api/descriptors"
import type { HydrationApi } from "./chains.ts"
import { formatUnits } from "./format.ts"
import { type CircuitBreakerState, getCircuitBreakerState, quoteXcmFees } from "./hydration.ts"
import { accumulatorLoad, type ChunkPlan } from "./plan.ts"
import { assetHubAssetLocation, DOT_LOCATION, type Weight, type XcmLocation } from "./xcm.ts"

const HDX_LOCATION: XcmLocation = {
	parents: 0,
	interior: { type: "X1", value: { type: "GeneralIndex", value: 0n } },
}

export interface SweepEconomics {
	readonly weight: Weight
	readonly fees: ReadonlyMap<string, bigint | undefined>
	readonly usdtPerHdx: number | undefined
	readonly breaker: CircuitBreakerState | undefined
	readonly limitUnits: number | undefined
	readonly windowMs: number | undefined
}

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

export function describeFootprint(
	plan: ChunkPlan,
	limitUnits: number,
	windowMs: number,
	intervalMs: number,
	maxFootprint: number,
): string[] {
	const load = accumulatorLoad(plan, intervalMs, windowMs)
	const pct = (units: number) => `${((100 * units) / limitUnits).toFixed(1)}%`
	const usd = (units: number) => formatUnits(BigInt(Math.round(units)), 6, "USD")
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
