import { parseArgs } from "node:util"
import { connectHydration, type HydrationApi } from "./chains.ts"
import { DEFAULT_ENDPOINTS, HDX_DECIMALS } from "./config.ts"
import { formatUnits, heading } from "./format.ts"
import { decayAccumulator } from "./hydration.ts"

/**
 * Reconstructs the history of Hydration's global XCM egress limit utilisation by sampling
 * `CircuitBreaker.WithdrawLimitAccumulator` (and the config / lockdown state) at past blocks on an
 * archive node, and reports how often our chunk would not have fitted.
 */

interface Sample {
	readonly block: number
	readonly timeMs: number
	/** Accumulator decayed to the sample time, in HDX raw units. */
	readonly value: bigint
	readonly limit: bigint
	readonly windowMs: bigint
	readonly lockdown: boolean
	/** `value / limit`, 0..1. */
	readonly utilisation: number
}

const HELP = `Sample Hydration's XCM egress circuit breaker over the past days.

Usage: npm run breaker-history -- [options]
  --days <n>             How far back to look (default: 7)
  --step-minutes <n>     Sampling interval (default: 30)
  --chunk-share <0..1>   Share of the limit one of our executions needs (default: 0.092)
  --concurrency <n>      Parallel RPC samples (default: 8)
  --hydration-ws <url>   Hydration archive RPC endpoint (repeatable)
  -h, --help
`

function parse(argv: readonly string[]) {
	const { values } = parseArgs({
		args: [...argv],
		options: {
			days: { type: "string", default: "7" },
			"step-minutes": { type: "string", default: "30" },
			"chunk-share": { type: "string", default: "0.092" },
			concurrency: { type: "string", default: "8" },
			"hydration-ws": { type: "string", multiple: true },
			help: { type: "boolean", short: "h", default: false },
		},
		strict: true,
	})
	const num = (v: string, flag: string) => {
		const n = Number(v)
		if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} expects a positive number`)
		return n
	}
	return {
		help: values.help,
		days: num(values.days, "--days"),
		stepMinutes: num(values["step-minutes"], "--step-minutes"),
		chunkShare: num(values["chunk-share"], "--chunk-share"),
		concurrency: Math.max(1, Math.floor(num(values.concurrency, "--concurrency"))),
		endpoints: values["hydration-ws"] ?? DEFAULT_ENDPOINTS.hydration,
	}
}

async function sampleAt(
	client: ReturnType<typeof connectHydration>["client"],
	api: HydrationApi,
	block: number,
): Promise<Sample | undefined> {
	const hash = await client._request<string, [number]>("chain_getBlockHash", [block])
	const at = { at: hash }
	const [config, [raw, updatedMs], lockdownUntil, timeMs] = await Promise.all([
		api.query.CircuitBreaker.GlobalWithdrawLimitConfig.getValue(at),
		api.query.CircuitBreaker.WithdrawLimitAccumulator.getValue(at),
		api.query.CircuitBreaker.WithdrawLockdownUntil.getValue(at),
		api.query.Timestamp.Now.getValue(at),
	])
	if (!config) return undefined
	const value = decayAccumulator(raw, updatedMs, timeMs, config.window)
	return {
		block,
		timeMs: Number(timeMs),
		value,
		limit: config.limit,
		windowMs: config.window,
		lockdown: lockdownUntil !== undefined && lockdownUntil > timeMs,
		utilisation: Number((value * 10_000n) / config.limit) / 10_000,
	}
}

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length)
	let next = 0
	const worker = async () => {
		while (next < items.length) {
			const index = next++
			const item = items[index]
			if (item !== undefined) results[index] = await fn(item)
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
	return results
}

function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0
	const index = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))
	return sorted[index] ?? 0
}

const SPARK = "▁▂▃▄▅▆▇█"
function spark(values: readonly number[]): string {
	return values
		.map(
			(v) =>
				SPARK[Math.min(SPARK.length - 1, Math.floor(Math.max(0, Math.min(1, v)) * SPARK.length))],
		)
		.join("")
}

async function main(argv: readonly string[]): Promise<void> {
	const options = parse(argv)
	if (options.help) {
		console.log(HELP)
		return
	}
	const hydration = connectHydration(options.endpoints)
	try {
		const finalized = await hydration.client.getFinalizedBlock()
		const timestampAt = async (height: number): Promise<number> => {
			const hash = await hydration.client._request<string, [number]>("chain_getBlockHash", [height])
			return Number(await hydration.api.query.Timestamp.Now.getValue({ at: hash }))
		}
		// Hydration's block time varies (elastic scaling), so sample by *time*: timestamp a set of anchor
		// heights covering the lookback (extending it until it covers the requested days), then
		// interpolate a height for every wanted sample time between the anchors.
		const nowMs = await timestampAt(finalized.number)
		const wantedMs = options.days * 24 * 3_600_000
		const roughBlockTimeMs = (nowMs - (await timestampAt(finalized.number - 600))) / 600
		let blocksBack = Math.min(finalized.number - 1, Math.round(wantedMs / roughBlockTimeMs))
		for (let i = 0; i < 4; i++) {
			const spanMs = nowMs - (await timestampAt(finalized.number - blocksBack))
			if (spanMs >= wantedMs * 0.98 || blocksBack >= finalized.number - 1) break
			blocksBack = Math.min(finalized.number - 1, Math.round((blocksBack * wantedMs) / spanMs) + 1)
		}
		const anchorCount = Math.max(16, Math.ceil(options.days * 4))
		const anchors = await Promise.all(
			Array.from({ length: anchorCount + 1 }, (_, i) => {
				const height = finalized.number - Math.round((blocksBack * (anchorCount - i)) / anchorCount)
				return timestampAt(height).then((timeMs) => ({ height, timeMs }))
			}),
		)
		const heightAt = (timeMs: number): number => {
			const first = anchors[0]
			const last = anchors[anchors.length - 1]
			if (!first || !last) throw new Error("no anchors")
			if (timeMs <= first.timeMs) return first.height
			if (timeMs >= last.timeMs) return last.height
			for (let i = 1; i < anchors.length; i++) {
				const a = anchors[i - 1]
				const b = anchors[i]
				if (a && b && timeMs <= b.timeMs) {
					const ratio = (timeMs - a.timeMs) / Math.max(1, b.timeMs - a.timeMs)
					return Math.round(a.height + ratio * (b.height - a.height))
				}
			}
			return last.height
		}
		const count = Math.max(1, Math.floor(wantedMs / (options.stepMinutes * 60_000)))
		const startMs = Math.max(anchors[0]?.timeMs ?? nowMs, nowMs - wantedMs)
		const heights = [
			...new Set(
				Array.from({ length: count + 1 }, (_, i) =>
					heightAt(startMs + ((nowMs - startMs) * i) / count),
				),
			),
		]
		const stepBlocks = heights.length > 1 ? Math.round(blocksBack / (heights.length - 1)) : 0
		console.log(heading("Hydration XCM egress circuit breaker — utilisation history"))
		console.log(
			`  ${heights.length} samples, every ${options.stepMinutes} min (~${stepBlocks} blocks on average; ~${(roughBlockTimeMs / 1000).toFixed(2)}s per block recently), ${new Date(startMs).toISOString()} .. ${new Date(nowMs).toISOString()} (block #${finalized.number})`,
		)

		const samples = (
			await mapWithConcurrency(heights, options.concurrency, (h) =>
				sampleAt(hydration.client, hydration.api, h),
			)
		).filter((s): s is Sample => s !== undefined)
		if (samples.length === 0)
			throw new Error("no samples (limit not configured in the sampled range?)")

		// Config changes in the sampled range.
		const configs = new Map<string, { from: number; to: number }>()
		for (const s of samples) {
			const key = `${s.limit}/${s.windowMs}`
			const entry = configs.get(key)
			if (entry) entry.to = s.timeMs
			else configs.set(key, { from: s.timeMs, to: s.timeMs })
		}
		console.log(heading("Limit configuration seen"))
		for (const [key, range] of configs) {
			const [limit, window] = key.split("/")
			console.log(
				`  limit ${formatUnits(BigInt(limit ?? "0"), HDX_DECIMALS, "HDX")} per ${Number(window) / 3_600_000}h: ${new Date(range.from).toISOString()} .. ${new Date(range.to).toISOString()}`,
			)
		}

		// Daily sparklines (one character per sample).
		console.log(heading("Utilisation per day (each char = one sample, 0..100% of the limit)"))
		const byDay = new Map<string, Sample[]>()
		for (const s of samples) {
			const day = new Date(s.timeMs).toISOString().slice(0, 10)
			byDay.set(day, [...(byDay.get(day) ?? []), s])
		}
		const latest = samples[samples.length - 1]
		const currentLimit = latest?.limit ?? 1n
		const limitChanged = configs.size > 1
		if (limitChanged) {
			console.log(
				`  (the limit changed in this range; "vs today" rescales each day's peak to the current limit of ${formatUnits(currentLimit, HDX_DECIMALS, "HDX")})`,
			)
		}
		for (const [day, daySamples] of byDay) {
			const max = Math.max(...daySamples.map((s) => s.utilisation))
			const peakValue = daySamples.reduce((best, s) => (s.value > best ? s.value : best), 0n)
			const vsToday = Number((peakValue * 10_000n) / currentLimit) / 100
			const lock = daySamples.some((s) => s.lockdown) ? "  LOCKDOWN" : ""
			console.log(
				`  ${day}  ${spark(daySamples.map((s) => s.utilisation)).padEnd(48)}  max ${(max * 100).toFixed(1).padStart(5)}%${limitChanged ? `  vs today ${vsToday.toFixed(1).padStart(5)}%` : ""}${lock}`,
			)
		}

		const utils = samples.map((s) => s.utilisation).sort((a, b) => a - b)
		const mean = utils.reduce((sum, u) => sum + u, 0) / utils.length
		const blocked = samples.filter(
			(s) => s.lockdown || 1 - s.utilisation < options.chunkShare,
		).length
		const peak = samples.reduce(
			(best, s) => (s.utilisation > best.utilisation ? s : best),
			samples[0] as Sample,
		)
		console.log(heading("Statistics"))
		console.log(
			`  mean ${(mean * 100).toFixed(1)}%   median ${(percentile(utils, 0.5) * 100).toFixed(1)}%   p90 ${(percentile(utils, 0.9) * 100).toFixed(1)}%   p99 ${(percentile(utils, 0.99) * 100).toFixed(1)}%   max ${(peak.utilisation * 100).toFixed(1)}% at ${new Date(peak.timeMs).toISOString()} (block #${peak.block})`,
		)
		console.log(
			`  samples above 50%: ${samples.filter((s) => s.utilisation > 0.5).length}, above 75%: ${samples.filter((s) => s.utilisation > 0.75).length}, in lockdown: ${samples.filter((s) => s.lockdown).length}`,
		)
		console.log(
			`  samples where an execution needing ${(options.chunkShare * 100).toFixed(1)}% of the limit would NOT have fitted: ${blocked} of ${samples.length} (${((100 * blocked) / samples.length).toFixed(1)}%)`,
		)
	} finally {
		hydration.client.destroy()
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(`\nerror: ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
})
