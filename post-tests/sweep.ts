import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { formatUnits } from "../src/format.ts"
import { toHexString } from "../src/hex.ts"
import { isRecord } from "../src/verify.ts"
import {
	type Any,
	advanceTime,
	blockDetailsEnabled,
	build,
	type Chain,
	connect,
	field,
	fireScheduledTask,
	flush,
	isTaskScheduled,
	jsonSafe,
	type PostTestContext,
	type ProxyOutcome,
	printBlockDetails,
	proxyOutcome,
	RELAY_SLOT_MS,
	setBlockDetails,
} from "./chopsticks.ts"

interface Summary {
	holder: string
	sovereignAccountOnHydration: string
	beneficiary: string
	amounts: Array<{
		symbol: string
		hydrationAssetId: number
		assetHubAssetId: string
		amount: string
	}>
	plan: { intervalBlocks: number; needed: number; extra: number; scheduled: number }
	fees: { topUp?: string; budgetPerExecution?: string; estimatedPerExecution?: string }
	proposal: { hash: string }
	schedulerTask: { id: string }
}

const DOT_ON_HYDRATION = 5
const DRAIN_THRESHOLD = 1_000_000n

async function breakerLimit(hydration: Chain): Promise<bigint | undefined> {
	const config =
		(await hydration.api.query.CircuitBreaker.GlobalWithdrawLimitConfig.getValue()) as {
			limit: bigint
		} | null
	return config?.limit
}

async function breakerPercent(hydration: Chain, limit: bigint | undefined): Promise<number> {
	if (!limit) return 0
	const [value] =
		(await hydration.api.query.CircuitBreaker.WithdrawLimitAccumulator.getValue()) as [
			bigint,
			bigint,
		]
	return Number((value * 10_000n) / limit) / 100
}

export default async function sweepPostTest(ctx: PostTestContext): Promise<void> {
	const outDir =
		(isRecord(ctx.args) && typeof ctx.args.outDir === "string" && ctx.args.outDir) || "out"
	const argNumber = (key: string, fallback: number): number => {
		const parsed = isRecord(ctx.args) ? Number(ctx.args[key]) : Number.NaN
		return Number.isFinite(parsed) ? parsed : fallback
	}
	const maxExecutions = argNumber("executions", 3)
	const maxBreakerPct = argNumber("maxBreakerPct", 20)
	setBlockDetails(argNumber("blockDetails", 1) !== 0)
	const summary: Summary = JSON.parse(readFileSync(join(outDir, "summary.json"), "utf-8"))

	const find = (needle: string) =>
		ctx.chains.find(
			(chain) => chain.specName.includes(needle) || chain.label.toLowerCase().includes(needle),
		)
	const assetHubMeta = find("asset-hub") ?? ctx.main
	const hydrationMeta = find("hydr") ?? find("hydra")
	assert.ok(
		hydrationMeta,
		"Hydration chain not found among the tester's forks (add it via --additional-chains)",
	)

	const assetHub = await connect(assetHubMeta)
	const hydration = await connect(hydrationMeta)
	try {
		const usdt = summary.amounts[0]
		const usdc = summary.amounts[1]
		assert.ok(usdt && usdc, "summary.json must list USDT and USDC")

		const holderToken = (assetId: number): Promise<bigint> =>
			hydration.api.query.Tokens.Accounts.getValue(summary.holder, assetId).then(
				(account: { free: bigint }) => account.free,
			)
		const sovereignDot = (): Promise<bigint> =>
			hydration.api.query.Tokens.Accounts.getValue(
				summary.sovereignAccountOnHydration,
				DOT_ON_HYDRATION,
			).then((account: { free: bigint }) => account.free)
		const treasury = (assetId: string): Promise<bigint> =>
			assetHub.api.query.Assets.Account.getValue(Number(assetId), summary.beneficiary).then(
				(account: { balance: bigint } | undefined) => account?.balance ?? 0n,
			)

		console.log("\n[post-test] checking the scheduled sweep task")
		const entries = await assetHub.api.query.Scheduler.Agenda.getEntries()
		const idOf = (item: unknown) => toHexString(field(item, "maybeId", "maybe_id"))
		const periodicOf = (item: unknown) => field(item, "maybePeriodic", "maybe_periodic")
		const tasksWithId: Array<{ block: number; item: Any }> = []
		for (const entry of entries) {
			for (const item of (entry.value ?? []) as unknown[]) {
				if (isRecord(item) && idOf(item) != null)
					tasksWithId.push({ block: Number(entry.keyArgs[0]), item })
			}
		}
		const sample = entries.flatMap((entry: { value: unknown[] }) => entry.value ?? []).find(Boolean)
		console.log(
			`  ${entries.length} agenda entries, ${tasksWithId.length} with an id; sample item keys: ${sample ? Object.keys(sample).join(",") : "none"}`,
		)
		let task: Any = tasksWithId.find(({ item }) => idOf(item) === summary.schedulerTask.id)?.item
		if (!task) {
			for (const { block, item } of tasksWithId) {
				console.log(
					`    @${block}: id=${idOf(item)} periodic=${JSON.stringify(periodicOf(item))} call=${JSON.stringify(Object.keys(item.call ?? {}))}`,
				)
			}
			task = tasksWithId.find(
				({ item }) =>
					Array.isArray(periodicOf(item)) &&
					Number(periodicOf(item)[0]) === summary.plan.intervalBlocks &&
					Number(periodicOf(item)[1]) === summary.plan.scheduled,
			)?.item
			if (task) console.log("  (matched by periodic signature instead of id)")
		}
		assert.ok(task, `task ${summary.schedulerTask.id} not scheduled on Asset Hub`)
		const taskPeriodic = field(task, "maybePeriodic", "maybe_periodic")
		assert.ok(Array.isArray(taskPeriodic), "sweep task must be periodic")
		const period = Number(taskPeriodic[0])
		const count = Number(taskPeriodic[1])
		console.log(
			`  ok: task scheduled every ${period} relay blocks, ${count} times (plan: ${summary.plan.intervalBlocks} / ${summary.plan.scheduled})`,
		)
		assert.equal(period, summary.plan.intervalBlocks, "periodic interval mismatch")
		assert.ok(
			count >= summary.plan.needed && count <= summary.plan.scheduled,
			`periodic count ${count} outside [${summary.plan.needed}, ${summary.plan.scheduled}]`,
		)

		const dot = await sovereignDot()
		const feeBudget = BigInt(summary.fees.budgetPerExecution ?? "0")
		if (summary.fees.topUp && BigInt(summary.fees.topUp) > 0n) {
			console.log(`  sovereign account balance ${formatUnits(dot, 10, "DOT")} after the top-up`)
			assert.ok(
				dot >= BigInt(summary.fees.topUp),
				"sovereign account was not funded by the top-up XCM",
			)
		} else {
			console.log(
				`  sovereign account balance ${formatUnits(dot, 10, "DOT")} (pre-funded out of band; no on-chain top-up)`,
			)
			assert.ok(
				dot >= feeBudget && dot > 0n,
				`sovereign account balance ${formatUnits(dot, 10, "DOT")} is below one execution's fee budget ${formatUnits(feeBudget, 10, "DOT")}; the out-of-band pre-funding did not apply`,
			)
		}

		const executions = Math.min(maxExecutions, summary.plan.scheduled)
		if (executions <= 0) {
			console.log(
				"\n[post-test] driving skipped (--post-test-args executions=0); enactment checks passed",
			)
			return
		}
		await flush(hydration, 2)
		await flush(assetHub, 2)
		const snapshot = async () => {
			const [holderUsdt, holderUsdc, treasuryUsdt, treasuryUsdc] = await Promise.all([
				holderToken(usdt.hydrationAssetId),
				holderToken(usdc.hydrationAssetId),
				treasury(usdt.assetHubAssetId),
				treasury(usdc.assetHubAssetId),
			])
			return { holderUsdt, holderUsdc, treasuryUsdt, treasuryUsdc }
		}
		const start = await snapshot()
		const fullRun = executions >= summary.plan.needed
		console.log(
			`\n[post-test] driving ${fullRun ? "the full sweep" : `${executions}`} of ${summary.plan.scheduled} executions`,
		)
		const egressLimit = await breakerLimit(hydration)
		let peakBreaker = await breakerPercent(hydration, egressLimit)
		let completionCount = 0
		let sweptToCompletion = false

		for (let execution = 1; execution <= executions; execution++) {
			const pre = await snapshot()
			if (pre.holderUsdt < DRAIN_THRESHOLD && pre.holderUsdc < DRAIN_THRESHOLD) {
				console.log(`  holder drained after ${completionCount} executions; sweep complete`)
				sweptToCompletion = true
				break
			}
			const before = { usdt: pre.treasuryUsdt, usdc: pre.treasuryUsdc }
			const dispatch = await fireScheduledTask(assetHub, summary.schedulerTask.id)
			console.log(`  [${execution}] Asset Hub dispatch result: ${jsonSafe(dispatch.result)}`)
			assert.ok(
				isRecord(dispatch.result) && dispatch.result.success === true,
				`execution ${execution}: scheduler dispatched but the call failed on Asset Hub: ${jsonSafe(dispatch.result)}`,
			)

			await advanceTime(hydration, summary.plan.intervalBlocks * RELAY_SLOT_MS)
			let outcome = await proxyOutcome(hydration)
			for (let attempt = 0; attempt < 25 && !outcome.ok; attempt++) {
				await build(hydration)
				outcome = await proxyOutcome(hydration)
			}
			if (!outcome.ok) {
				if (!blockDetailsEnabled()) await printBlockDetails(hydration)
				assert.fail(
					`execution ${execution}: proxied XTokens transfer ${outcome.seen ? "FAILED on Hydration" : "never executed on Hydration (message not delivered?)"}: ${outcome.error}`,
				)
			}

			let afterUsdt = before.usdt
			for (let attempt = 0; attempt < 10 && afterUsdt <= before.usdt; attempt++) {
				await build(assetHub)
				afterUsdt = await treasury(usdt.assetHubAssetId)
			}
			const [breakerNow, afterUsdc] = await Promise.all([
				breakerPercent(hydration, egressLimit),
				treasury(usdc.assetHubAssetId),
			])
			peakBreaker = Math.max(peakBreaker, breakerNow)
			const after = { usdt: afterUsdt, usdc: afterUsdc }
			completionCount = execution
			const label = fullRun ? `${execution}` : `${execution}/${executions}`
			console.log(
				`  [${label}] treasury +${formatUnits(after.usdt - before.usdt, 6, "USDT")} +${formatUnits(after.usdc - before.usdc, 6, "USDC")} (cumulative +${formatUnits(after.usdt - start.treasuryUsdt, 6, "USDT")} +${formatUnits(after.usdc - start.treasuryUsdc, 6, "USDC")}) | breaker ${peakBreaker.toFixed(1)}%`,
			)
			assert.ok(
				after.usdt > before.usdt && after.usdc > before.usdc,
				`execution ${execution}: treasury not credited (reserve withdrawal did not arrive on Asset Hub)`,
			)
		}

		let marginFiringCount = 0
		let scheduleComplete = false
		if (fullRun && sweptToCompletion) {
			console.log(
				"\n[post-test] exhausting the schedule: firing the remaining margin executions (holder empty, expect no-ops)",
			)
			for (
				let marginExecution = completionCount + 1;
				marginExecution <= summary.plan.scheduled;
				marginExecution++
			) {
				if (!(await isTaskScheduled(assetHub, summary.schedulerTask.id))) break
				const [beforeUsdt, beforeUsdc] = await Promise.all([
					treasury(usdt.assetHubAssetId),
					treasury(usdc.assetHubAssetId),
				])
				const dispatch = await fireScheduledTask(assetHub, summary.schedulerTask.id)
				let outcome: ProxyOutcome = { seen: false, ok: false }
				for (let attempt = 0; attempt < 25 && !outcome.seen; attempt++) {
					await build(hydration)
					outcome = await proxyOutcome(hydration)
				}
				assert.ok(
					outcome.seen,
					`margin execution ${marginExecution}: sweep XCM was not delivered to Hydration`,
				)
				assert.ok(
					!outcome.ok,
					`margin execution ${marginExecution}: proxied transfer unexpectedly SUCCEEDED though the holder is empty`,
				)
				await flush(assetHub, 2)
				const [afterUsdt, afterUsdc] = await Promise.all([
					treasury(usdt.assetHubAssetId),
					treasury(usdc.assetHubAssetId),
				])
				assert.ok(
					afterUsdt === beforeUsdt && afterUsdc === beforeUsdc,
					`margin execution ${marginExecution} moved funds though the holder is empty`,
				)
				marginFiringCount++
				console.log(
					`  [${marginExecution}] margin dispatch ${jsonSafe(dispatch.result)}; delivered to Hydration, transfer rejected as expected, no funds moved`,
				)
			}
			scheduleComplete = !(await isTaskScheduled(assetHub, summary.schedulerTask.id))
			console.log(
				`  fired ${marginFiringCount} margin execution(s); scheduler task still present afterwards: ${!scheduleComplete}`,
			)
		}

		const end = await snapshot()
		const treasuryGainUsdt = end.treasuryUsdt - start.treasuryUsdt
		const treasuryGainUsdc = end.treasuryUsdc - start.treasuryUsdc
		const holderDropUsdt = start.holderUsdt - end.holderUsdt
		const holderDropUsdc = start.holderUsdc - end.holderUsdc

		console.log("\n[post-test] results")
		console.log(
			`  executions      ${completionCount}${sweptToCompletion ? " (holder fully drained)" : ""}`,
		)
		if (fullRun) {
			console.log(
				`  margin firings  ${marginFiringCount} (delivered to Hydration, transfer rejected, no funds moved); schedule ${scheduleComplete ? "complete; task removed from Scheduler.Lookup" : "NOT complete (task still scheduled)"}`,
			)
		}
		console.log(
			`  treasury gained ${formatUnits(treasuryGainUsdt, 6, "USDT")} + ${formatUnits(treasuryGainUsdc, 6, "USDC")}`,
		)
		console.log(
			`  holder dropped  ${formatUnits(holderDropUsdt, 6, "USDT")} + ${formatUnits(holderDropUsdc, 6, "USDC")}`,
		)
		console.log(
			`  holder left     ${formatUnits(end.holderUsdt, 6, "USDT")} + ${formatUnits(end.holderUsdc, 6, "USDC")}`,
		)
		console.log(`  peak breaker    ${peakBreaker.toFixed(1)}% (cap ${maxBreakerPct}%)`)

		const near = (first: bigint, second: bigint, toleranceDivisor = 100n) => {
			const diff = first > second ? first - second : second - first
			return diff * toleranceDivisor <= first
		}

		assert.ok(treasuryGainUsdt > 0n && treasuryGainUsdc > 0n, "treasury was not credited")
		assert.ok(holderDropUsdt > 0n && holderDropUsdc > 0n, "holder balance did not decrease")
		assert.ok(
			near(treasuryGainUsdt, holderDropUsdt),
			"USDT: treasury gain and holder drop diverge by >1%",
		)
		assert.ok(
			near(treasuryGainUsdc, holderDropUsdc),
			"USDC: treasury gain and holder drop diverge by >1%",
		)
		assert.ok(peakBreaker <= maxBreakerPct, `breaker peaked at ${peakBreaker}% > ${maxBreakerPct}%`)
		if (fullRun) {
			assert.ok(
				sweptToCompletion,
				"full run did not drain the holder within the scheduled executions",
			)
			assert.ok(
				scheduleComplete,
				"schedule did not complete: the scheduler task is still present after all scheduled executions",
			)
			assert.ok(
				end.holderUsdt < DRAIN_THRESHOLD && end.holderUsdc < DRAIN_THRESHOLD,
				`holder not fully swept: ${formatUnits(end.holderUsdt, 6, "USDT")} + ${formatUnits(end.holderUsdc, 6, "USDC")} left`,
			)
			assert.ok(
				near(treasuryGainUsdt, start.holderUsdt, 200n) &&
					near(treasuryGainUsdc, start.holderUsdc, 200n),
				"full run: treasury gain is not close to the holder's starting balance",
			)
		}
		console.log("\n[post-test] all assertions passed")
	} finally {
		hydration.client.destroy()
		assetHub.client.destroy()
	}
}
