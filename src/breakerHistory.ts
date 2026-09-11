import { parseArgs } from "node:util"
import { connectHydration, type HydrationApi } from "./chains.ts"
import { DEFAULT_ENDPOINTS, HDX_DECIMALS } from "./config.ts"
import { formatUnits, heading } from "./format.ts"
import { decayAccumulator } from "./hydration.ts"

interface Sample {
	readonly block: number
	readonly timeMs: number
	readonly value: bigint
	readonly limit: bigint
	readonly windowMs: bigint
	readonly lockdown: boolean
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
	const positiveNumber = (text: string, flag: string) => {
		const numeric = Number(text)
		if (!Number.isFinite(numeric) || numeric <= 0)
			throw new Error(`${flag} expects a positive number`)
		return numeric
	}
	return {
		help: values.help,
		days: positiveNumber(values.days, "--days"),
		stepMinutes: positiveNumber(values["step-minutes"], "--step-minutes"),
		chunkShare: positiveNumber(values["chunk-share"], "--chunk-share"),
		concurrency: Math.max(1, Math.floor(positiveNumber(values.concurrency, "--concurrency"))),
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

function percentile(sorted: readonly number[], fraction: number): number {
	if (sorted.length === 0) return 0
	const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))
	return sorted[index] ?? 0
}

const SPARK = "▁▂▃▄▅▆▇█"
function spark(values: readonly number[]): string {
	return values
		.map(
			(utilisation) =>
				SPARK[
					Math.min(
						SPARK.length - 1,
						Math.floor(Math.max(0, Math.min(1, utilisation)) * SPARK.length),
					)
				],
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
		const finalizedBlock = await hydration.client.getFinalizedBlock()
		const timestampAt = async (height: number): Promise<number> => {
			const hash = await hydration.client._request<string, [number]>("chain_getBlockHash", [height])
			return Number(await hydration.api.query.Timestamp.Now.getValue({ at: hash }))
		}
		const nowMs = await timestampAt(finalizedBlock.number)
		const wantedMs = options.days * 24 * 3_600_000
		const roughBlockTimeMs = (nowMs - (await timestampAt(finalizedBlock.number - 600))) / 600
		let blocksBack = Math.min(finalizedBlock.number - 1, Math.round(wantedMs / roughBlockTimeMs))
		for (let attempt = 0; attempt < 4; attempt++) {
			const spanMs = nowMs - (await timestampAt(finalizedBlock.number - blocksBack))
			if (spanMs >= wantedMs * 0.98 || blocksBack >= finalizedBlock.number - 1) break
			blocksBack = Math.min(
				finalizedBlock.number - 1,
				Math.round((blocksBack * wantedMs) / spanMs) + 1,
			)
		}
		const anchorCount = Math.max(16, Math.ceil(options.days * 4))
		const anchors = await Promise.all(
			Array.from({ length: anchorCount + 1 }, (_, anchorIndex) => {
				const height =
					finalizedBlock.number -
					Math.round((blocksBack * (anchorCount - anchorIndex)) / anchorCount)
				return timestampAt(height).then((timeMs) => ({ height, timeMs }))
			}),
		)
		const heightAt = (timeMs: number): number => {
			const first = anchors[0]
			const last = anchors[anchors.length - 1]
			if (!first || !last) throw new Error("no anchors")
			if (timeMs <= first.timeMs) return first.height
			if (timeMs >= last.timeMs) return last.height
			for (let position = 1; position < anchors.length; position++) {
				const previous = anchors[position - 1]
				const current = anchors[position]
				if (previous && current && timeMs <= current.timeMs) {
					const ratio = (timeMs - previous.timeMs) / Math.max(1, current.timeMs - previous.timeMs)
					return Math.round(previous.height + ratio * (current.height - previous.height))
				}
			}
			return last.height
		}
		const count = Math.max(1, Math.floor(wantedMs / (options.stepMinutes * 60_000)))
		const startMs = Math.max(anchors[0]?.timeMs ?? nowMs, nowMs - wantedMs)
		const heights = [
			...new Set(
				Array.from({ length: count + 1 }, (_, sampleIndex) =>
					heightAt(startMs + ((nowMs - startMs) * sampleIndex) / count),
				),
			),
		]
		const stepBlocks = heights.length > 1 ? Math.round(blocksBack / (heights.length - 1)) : 0
		console.log(heading("Hydration XCM egress circuit breaker: utilisation history"))
		console.log(
			`  ${heights.length} samples, every ${options.stepMinutes} min (~${stepBlocks} blocks on average; ~${(roughBlockTimeMs / 1000).toFixed(2)}s per block recently), ${new Date(startMs).toISOString()} .. ${new Date(nowMs).toISOString()} (block #${finalizedBlock.number})`,
		)

		const samples = (
			await mapWithConcurrency(heights, options.concurrency, (height) =>
				sampleAt(hydration.client, hydration.api, height),
			)
		).filter((sample): sample is Sample => sample !== undefined)
		if (samples.length === 0)
			throw new Error("no samples (limit not configured in the sampled range?)")

		const configs = new Map<string, { from: number; to: number }>()
		for (const sample of samples) {
			const key = `${sample.limit}/${sample.windowMs}`
			const entry = configs.get(key)
			if (entry) entry.to = sample.timeMs
			else configs.set(key, { from: sample.timeMs, to: sample.timeMs })
		}
		console.log(heading("Limit configuration seen"))
		for (const [key, range] of configs) {
			const [limit, window] = key.split("/")
			console.log(
				`  limit ${formatUnits(BigInt(limit ?? "0"), HDX_DECIMALS, "HDX")} per ${Number(window) / 3_600_000}h: ${new Date(range.from).toISOString()} .. ${new Date(range.to).toISOString()}`,
			)
		}

		console.log(heading("Utilisation per day (each char = one sample, 0..100% of the limit)"))
		const byDay = new Map<string, Sample[]>()
		for (const sample of samples) {
			const day = new Date(sample.timeMs).toISOString().slice(0, 10)
			byDay.set(day, [...(byDay.get(day) ?? []), sample])
		}
		const latest = samples[samples.length - 1]
		const currentLimit = latest?.limit ?? 1n
		const multipleLimits = configs.size > 1
		if (multipleLimits) {
			console.log(
				`  (the limit changed in this range; "vs today" rescales each day's peak to the current limit of ${formatUnits(currentLimit, HDX_DECIMALS, "HDX")})`,
			)
		}
		for (const [day, daySamples] of byDay) {
			const max = Math.max(...daySamples.map((sample) => sample.utilisation))
			const peakValue = daySamples.reduce(
				(best, sample) => (sample.value > best ? sample.value : best),
				0n,
			)
			const vsToday = Number((peakValue * 10_000n) / currentLimit) / 100
			const lock = daySamples.some((sample) => sample.lockdown) ? "  LOCKDOWN" : ""
			console.log(
				`  ${day}  ${spark(daySamples.map((sample) => sample.utilisation)).padEnd(48)}  max ${(max * 100).toFixed(1).padStart(5)}%${multipleLimits ? `  vs today ${vsToday.toFixed(1).padStart(5)}%` : ""}${lock}`,
			)
		}

		const utilisations = samples
			.map((sample) => sample.utilisation)
			.sort((first, second) => first - second)
		const mean =
			utilisations.reduce((sum, utilisation) => sum + utilisation, 0) / utilisations.length
		const blockedSampleCount = samples.filter(
			(sample) => sample.lockdown || 1 - sample.utilisation < options.chunkShare,
		).length
		const peak = samples.reduce(
			(best, sample) => (sample.utilisation > best.utilisation ? sample : best),
			samples[0] as Sample,
		)
		console.log(heading("Statistics"))
		console.log(
			`  mean ${(mean * 100).toFixed(1)}%   median ${(percentile(utilisations, 0.5) * 100).toFixed(1)}%   p90 ${(percentile(utilisations, 0.9) * 100).toFixed(1)}%   p99 ${(percentile(utilisations, 0.99) * 100).toFixed(1)}%   max ${(peak.utilisation * 100).toFixed(1)}% at ${new Date(peak.timeMs).toISOString()} (block #${peak.block})`,
		)
		console.log(
			`  samples above 50%: ${samples.filter((sample) => sample.utilisation > 0.5).length}, above 75%: ${samples.filter((sample) => sample.utilisation > 0.75).length}, in lockdown: ${samples.filter((sample) => sample.lockdown).length}`,
		)
		console.log(
			`  samples where an execution needing ${(options.chunkShare * 100).toFixed(1)}% of the limit would NOT have fitted: ${blockedSampleCount} of ${samples.length} (${((100 * blockedSampleCount) / samples.length).toFixed(1)}%)`,
		)
	} finally {
		hydration.client.destroy()
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(`\nerror: ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
})
