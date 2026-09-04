import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setStorage, timeTravel } from "@acala-network/chopsticks-core"
import { createClient, type PolkadotClient } from "polkadot-api"
import { getWsProvider } from "polkadot-api/ws"
import { formatUnits as fmt } from "../src/format.ts"

/**
 * Post-referendum test for the Hydration treasury sweep, run by `polkadot-referenda-tester` via
 * its `--post-test` hook against the live post-execution Chopsticks network (Asset Hub + Hydration).
 *
 * Reads go through a `polkadot-api` `getUnsafeApi()` client over each fork's WS endpoint (untyped, so
 * no generated descriptors are needed). Block building and storage writes go through the live
 * chopsticks-core `Blockchain` object the tester hands over (`chain.newBlock()` / `setStorage` /
 * `timeTravel`): in-process building lets `connectParachains` deliver the AH<->Hydration
 * sibling HRMP the sweep relies on.
 *
 * It asserts the enactment-level facts (the named periodic task is scheduled with the right period
 * and count; the sovereign account holds the fee DOT — from the top-up XCM or an out-of-band
 * prefund), then drives a bounded number of executions — relocating the scheduler task forward each
 * time — and asserts that each sweep credits the Asset Hub treasury, empties the holder, keeps the
 * proxied call succeeding, and never pushes Hydration's egress circuit breaker over its limit. On a
 * full run it then fires the remaining margin executions (each must be delivered and rejected — the
 * holder is empty) and asserts the schedule completes: the named task leaves `Scheduler.Lookup`.
 */

// Minimal view of the chopsticks-core Blockchain object we build blocks on.
interface Blockchain {
	newBlock(params?: {
		transactions?: string[]
		relayParentNumber?: number
		unsafeBlockHeight?: number
		relayChainStateOverrides?: Array<[string, string]>
	}): Promise<unknown>
}

interface PostTestChain {
	label: string
	specName: string
	wsEndpoint: string
	chain: unknown
}
interface PostTestContext {
	main: PostTestChain
	chains: PostTestChain[]
	args: unknown
}
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
const RELAY_SLOT_MS = 6000
/** Relay-chain `Babe::CurrentSlot` key inside the relay state proof. */
const RELAY_CURRENT_SLOT_KEY = "0x1cb6f36e027abb2091cfb5110ab5087f06155b3cd9a8c9e5e9a23fd5dc13a5ed"
/** Ceiling for one chopsticks operation, longer than subway's full upstream-failover window. */
const OP_TIMEOUT_MS = 300_000

// biome-ignore lint/suspicious/noExplicitAny: getUnsafeApi() is deliberately untyped here.
type AnyApi = any

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

/** Normalize a value that may be a polkadot-api Binary/FixedSizeBinary (from getUnsafeApi) to hex. */
// biome-ignore lint/suspicious/noExplicitAny: runtime Binary shape.
function hx(v: any): string | undefined {
	if (v == null) return undefined
	if (typeof v === "string") return v
	if (typeof v.asHex === "function") return v.asHex()
	if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString("hex")}`
	return String(v)
}

/**
 * `getUnsafeApi()` returns raw runtime field names, which for the scheduler are snake_case
 * (`maybe_id`, `maybe_periodic`); the typed API uses camelCase. Read either.
 */
// biome-ignore lint/suspicious/noExplicitAny: runtime-shaped.
function field(item: any, ...names: string[]): any {
	for (const n of names) if (item?.[n] !== undefined) return item[n]
	return undefined
}

/** Human/storage form of a scheduler agenda item (chopsticks `dev_setStorage`). */
// biome-ignore lint/suspicious/noExplicitAny: agenda items are runtime-shaped.
function toStorageAgendaItem(item: any): unknown {
	const call = item.call
	const storageCall =
		call?.type === "Inline"
			? { inline: hx(call.value) }
			: call?.type === "Lookup"
				? { lookup: { hash: hx(call.value.hash), len: call.value.len } }
				: call
	const originType = item.origin?.type
	const origin = originType
		? { [String(originType).toLowerCase()]: item.origin.value?.type ?? item.origin.value }
		: item.origin
	return {
		maybeId: hx(field(item, "maybeId", "maybe_id")) ?? null,
		priority: item.priority,
		call: storageCall,
		maybePeriodic: field(item, "maybePeriodic", "maybe_periodic") ?? null,
		origin,
	}
}

interface Chain {
	client: PolkadotClient
	api: AnyApi
	/** Live chopsticks-core Blockchain, for in-process block building + storage writes. */
	bc: Blockchain
	slotMs: number
}

/** Reject if a promise takes longer than `ms` — a Chopsticks build can occasionally wedge. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms).unref(),
		),
	])
}

async function connect(meta: PostTestChain): Promise<Chain> {
	if (!meta.chain) throw new Error(`no chopsticks Blockchain object passed for ${meta.label}`)
	const client = createClient(getWsProvider(meta.wsEndpoint))
	const api = client.getUnsafeApi() as unknown as AnyApi
	const slotMs = Number(await api.constants.Aura.SlotDuration())
	return { client, api, bc: meta.chain as Blockchain, slotMs }
}

/** Build one block in-process (so connectParachains relays HRMP), then let the ws reader catch up. */
async function build(chain: Chain): Promise<void> {
	await withTimeout(chain.bc.newBlock(), OP_TIMEOUT_MS, "newBlock")
}

function encodeU64Le(v: bigint): string {
	const bytes = new Uint8Array(8)
	new DataView(bytes.buffer).setBigUint64(0, v, true)
	return `0x${Buffer.from(bytes).toString("hex")}`
}

/**
 * Advance a parachain's clock by `deltaMs` while keeping the block acceptable to the async-backing
 * consensus hook, which requires `parachain_slot == relay_CurrentSlot / velocity` (velocity =
 * slot_duration / 6s). The identity `parachain_slot * velocity == timestamp / 6000` makes the needed
 * relay `CurrentSlot` simply `t / 6000` for any slot duration. We time-travel the parent to `t -
 * slot_duration` so the built block lands exactly on `t`, override the relay `CurrentSlot`, and bump
 * the relay parent by `deltaMs / 6s`. This lets Hydration's egress circuit breaker decay
 * between executions (its accumulator decays against `Timestamp.Now`).
 */
async function advanceTime(chain: Chain, deltaMs: number): Promise<void> {
	const [now, relayParent] = await Promise.all([
		chain.api.query.Timestamp.Now.getValue(),
		chain.api.query.ParachainSystem.LastRelayChainBlockNumber.getValue(),
	])
	const t1 = Number(now) + deltaMs
	await withTimeout(timeTravel(chain.bc as never, t1 - chain.slotMs), OP_TIMEOUT_MS, "timeTravel")
	await withTimeout(
		chain.bc.newBlock({
			relayParentNumber: Number(relayParent) + Math.round(deltaMs / RELAY_SLOT_MS),
			relayChainStateOverrides: [
				[RELAY_CURRENT_SLOT_KEY, encodeU64Le(BigInt(Math.floor(t1 / RELAY_SLOT_MS)))],
			],
		}),
		OP_TIMEOUT_MS,
		"newBlock(advanceTime)",
	)
}

// biome-ignore lint/suspicious/noExplicitAny: chopsticks setStorage takes its own StorageValues shape.
async function setStore(chain: Chain, values: any): Promise<void> {
	await withTimeout(setStorage(chain.bc as never, values), OP_TIMEOUT_MS, "setStorage")
}

/** The `Scheduler.Dispatched` result for our task in the last block, or undefined if it didn't fire. */
async function ourDispatch(ah: Chain, taskId: string): Promise<{ result: unknown } | undefined> {
	const events = (await ah.api.query.System.Events.getValue()) as Array<{
		event: { type: string; value: { type: string; value: unknown } }
	}>
	const ev = events.find(
		(e) =>
			e.event.type === "Scheduler" &&
			e.event.value.type === "Dispatched" &&
			isRecord(e.event.value.value) &&
			hx((e.event.value.value as { id?: unknown }).id) === taskId,
	)
	if (!ev || !isRecord(ev.event.value.value)) return undefined
	return { result: (ev.event.value.value as { result?: unknown }).result }
}

const jsonSafe = (v: unknown) =>
	JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))

/**
 * Relocate our named periodic task to the current relay block and build until it dispatches. Setting
 * `IncompleteSince` to the target guarantees `service_agendas` starts the scan there (otherwise the
 * cursor can sit past our task and skip it). Verified by a `Scheduler.Dispatched` event carrying our
 * task id — not just any dispatch, since other Root tasks share the agenda — and that dispatch is
 * returned so callers need not re-read the events.
 */
async function fireScheduledTask(ah: Chain, taskId: string): Promise<{ result: unknown }> {
	const entries = await ah.api.query.Scheduler.Agenda.getEntries()
	let fromBlock: number | undefined
	let items: unknown
	for (const entry of entries) {
		const list = entry.value as unknown[]
		if (list?.some((it) => isRecord(it) && hx(field(it, "maybeId", "maybe_id")) === taskId)) {
			fromBlock = Number(entry.keyArgs[0])
			items = list
			break
		}
	}
	if (fromBlock === undefined) throw new Error(`scheduled task ${taskId} not found in the agenda`)

	const target = Number(await ah.api.query.ParachainSystem.LastRelayChainBlockNumber.getValue())
	// biome-ignore lint/suspicious/noExplicitAny: agenda items are runtime-shaped.
	const converted = (items as any[]).map(toStorageAgendaItem)
	await setStore(ah, {
		Scheduler: {
			Agenda: [
				[[fromBlock], null],
				[[target], converted],
			],
			IncompleteSince: target,
		},
	})
	try {
		const lookup = await ah.api.query.Scheduler.Lookup.getValue(taskId)
		if (lookup) await setStore(ah, { Scheduler: { Lookup: [[[taskId], [target, 0]]] } })
	} catch {
		// no Lookup entry (Inline task) — nothing to move
	}
	for (let attempt = 0; attempt < 3; attempt++) {
		await build(ah)
		const dispatch = await ourDispatch(ah, taskId)
		if (dispatch) return dispatch
	}
	throw new Error(`scheduler did not dispatch task ${taskId} after relocation`)
}

/**
 * Whether our named periodic task is still on the scheduler. A periodic task emits no dedicated
 * "finished" event — once its count reaches zero the runtime simply stops rescheduling it and drops
 * its `Scheduler.Lookup` entry, so the entry's absence is the definitive "schedule complete" signal.
 */
async function isTaskScheduled(ah: Chain, taskId: string): Promise<boolean> {
	try {
		const lookup = await ah.api.query.Scheduler.Lookup.getValue(taskId)
		return lookup !== undefined && lookup !== null
	} catch {
		return false
	}
}

/** Build `n` blocks on a chain to flush queued XCM messages. */
async function flush(chain: Chain, n: number): Promise<void> {
	for (let i = 0; i < n; i++) await build(chain)
}

/**
 * The proxied sweep call's outcome in the latest Hydration block. `seen` distinguishes "the XCM has
 * not been delivered/executed yet" (retry with more blocks) from "delivered, and the inner transfer
 * succeeded/failed" — after the holder is drained the margin executions are still delivered but the
 * transfer must fail, so both halves are asserted separately.
 */
async function proxyOutcome(chain: Chain): Promise<{ seen: boolean; ok: boolean; error?: string }> {
	const events = (await chain.api.query.System.Events.getValue()) as Array<{
		event: { type: string; value: { type: string; value: unknown } }
	}>
	const proxy = events.find(
		(e) => e.event.type === "Proxy" && e.event.value.type === "ProxyExecuted",
	)
	if (!proxy) return { seen: false, ok: false, error: "no Proxy.ProxyExecuted event" }
	const result = isRecord(proxy.event.value.value) ? proxy.event.value.value.result : undefined
	if (isRecord(result) && result.success === true) return { seen: true, ok: true }
	return { seen: true, ok: false, error: jsonSafe(result) }
}

/** The egress limit is governance-set and constant during the test — read it once, up front. */
async function breakerLimit(hyd: Chain): Promise<bigint | undefined> {
	const config = (await hyd.api.query.CircuitBreaker.GlobalWithdrawLimitConfig.getValue()) as {
		limit: bigint
	} | null
	return config?.limit
}

async function breakerPercent(hyd: Chain, limit: bigint | undefined): Promise<number> {
	if (!limit) return 0
	const [value] = (await hyd.api.query.CircuitBreaker.WithdrawLimitAccumulator.getValue()) as [
		bigint,
		bigint,
	]
	return Number((value * 10_000n) / limit) / 100
}

export default async function sweepPostTest(ctx: PostTestContext): Promise<void> {
	const outDir =
		(isRecord(ctx.args) && typeof ctx.args.outDir === "string" && ctx.args.outDir) || "out"
	const argNum = (k: string, dflt: number): number => {
		const n = isRecord(ctx.args) ? Number(ctx.args[k]) : Number.NaN
		return Number.isFinite(n) ? n : dflt
	}
	const maxExecutions = argNum("executions", 3)
	const maxBreakerPct = argNum("maxBreakerPct", 20)
	const summary: Summary = JSON.parse(readFileSync(join(outDir, "summary.json"), "utf-8"))

	const find = (needle: string) =>
		ctx.chains.find((c) => c.specName.includes(needle) || c.label.toLowerCase().includes(needle))
	const ahChain = find("asset-hub") ?? ctx.main
	const hydChain = find("hydr") ?? find("hydra")
	assert.ok(
		hydChain,
		"Hydration chain not found among the tester's forks (add it via --additional-chains)",
	)

	const ah = await connect(ahChain)
	const hyd = await connect(hydChain)
	try {
		const usdt = summary.amounts[0]
		const usdc = summary.amounts[1]
		assert.ok(usdt && usdc, "summary.json must list USDT and USDC")

		const holderToken = (id: number) =>
			hyd.api.query.Tokens.Accounts.getValue(summary.holder, id).then(
				(b: { free: bigint }) => b.free,
			)
		const sovereignDot = () =>
			hyd.api.query.Tokens.Accounts.getValue(
				summary.sovereignAccountOnHydration,
				DOT_ON_HYDRATION,
			).then((b: { free: bigint }) => b.free)
		const treasury = (assetId: string) =>
			ah.api.query.Assets.Account.getValue(Number(assetId), summary.beneficiary).then(
				(b: { balance: bigint } | undefined) => b?.balance ?? 0n,
			)

		// --- Assertion 1: the named periodic task exists with the right period and count -------------
		console.log("\n[post-test] checking the scheduled sweep task…")
		const entries = await ah.api.query.Scheduler.Agenda.getEntries()
		const idOf = (it: unknown) => hx(field(it, "maybeId", "maybe_id"))
		const periodicOf = (it: unknown) => field(it, "maybePeriodic", "maybe_periodic")
		// biome-ignore lint/suspicious/noExplicitAny: runtime-shaped.
		const named: Array<{ block: number; item: any }> = []
		for (const entry of entries) {
			for (const it of (entry.value ?? []) as unknown[]) {
				if (isRecord(it) && idOf(it) != null)
					named.push({ block: Number(entry.keyArgs[0]), item: it })
			}
		}
		const sample = entries.flatMap((e: { value: unknown[] }) => e.value ?? []).find(Boolean)
		console.log(
			`  ${entries.length} agenda entries, ${named.length} named; sample item keys: ${sample ? Object.keys(sample).join(",") : "none"}`,
		)
		// biome-ignore lint/suspicious/noExplicitAny: runtime-shaped.
		let task: any = named.find(({ item }) => idOf(item) === summary.schedulerTask.id)?.item
		if (!task) {
			for (const { block, item } of named) {
				console.log(
					`    @${block}: id=${idOf(item)} periodic=${JSON.stringify(periodicOf(item))} call=${JSON.stringify(Object.keys(item.call ?? {}))}`,
				)
			}
			// Fall back to the unique periodic task matching our interval + count.
			task = named.find(
				({ item }) =>
					Array.isArray(periodicOf(item)) &&
					Number(periodicOf(item)[0]) === summary.plan.intervalBlocks &&
					Number(periodicOf(item)[1]) === summary.plan.scheduled,
			)?.item
			if (task) console.log("  (matched by periodic signature instead of id)")
		}
		assert.ok(task, `named task ${summary.schedulerTask.id} not scheduled on Asset Hub`)
		const taskPeriodic = field(task, "maybePeriodic", "maybe_periodic")
		assert.ok(Array.isArray(taskPeriodic), "sweep task must be periodic")
		const [period, count] = [Number(taskPeriodic[0]), Number(taskPeriodic[1])]
		console.log(
			`  ok: named task scheduled — every ${period} relay blocks, ${count} times (plan: ${summary.plan.intervalBlocks} / ${summary.plan.scheduled})`,
		)
		assert.equal(period, summary.plan.intervalBlocks, "periodic interval mismatch")
		// pallet_scheduler stores the periodic count as remaining repetitions; the tester may have
		// built a block or two that already ran the first occurrence, so allow needed..scheduled.
		assert.ok(
			count >= summary.plan.needed && count <= summary.plan.scheduled,
			`periodic count ${count} outside [${summary.plan.needed}, ${summary.plan.scheduled}]`,
		)

		// --- Assertion 2: the sovereign account is funded for XCM fees -------------------------------
		// Either the on-chain top-up XCM funded it, or it was pre-funded out of band (a chopsticks
		// import-storage override, or a real transfer before enactment). We verify it ACTUALLY holds
		// the DOT: with `--assume-sovereign-dot` the generator only *assumes* this and skips the live
		// balance check, so the test is where the assumption has to be confirmed against the fork.
		const dot = await sovereignDot()
		const feeBudget = BigInt(summary.fees.budgetPerExecution ?? "0")
		if (summary.fees.topUp && BigInt(summary.fees.topUp) > 0n) {
			console.log(`  sovereign account holds ${fmt(dot, 10, "DOT")} after the top-up`)
			assert.ok(
				dot >= BigInt(summary.fees.topUp),
				"sovereign account was not funded by the top-up XCM",
			)
		} else {
			console.log(
				`  sovereign account holds ${fmt(dot, 10, "DOT")} (pre-funded out of band; no on-chain top-up)`,
			)
			assert.ok(
				dot >= feeBudget && dot > 0n,
				`sovereign account holds ${fmt(dot, 10, "DOT")}, below one execution's fee budget ${fmt(feeBudget, 10, "DOT")} — the out-of-band pre-funding (storage override / transfer) did not apply`,
			)
		}

		// --- Assertion 3: drive a bounded number of executions and check the effects -----------------
		const executionsWanted = Math.min(maxExecutions, summary.plan.scheduled)
		if (executionsWanted <= 0) {
			console.log(
				"\n[post-test] driving skipped (--post-test-args executions=0); enactment checks passed ✓",
			)
			return
		}
		// The task's first occurrence already fired once while the tester built blocks; flush its
		// in-flight XCM through both chains so it does not pollute the per-execution accounting.
		await flush(hyd, 2)
		await flush(ah, 2)
		/** One consistent read of the four balances the accounting tracks (independent, so batched). */
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
		const executions = executionsWanted
		// A full run is any request to drive at least every needed execution; then we expect the holder
		// to end drained. Below ~1 token of a 6-dp stablecoin an execution can no longer move a chunk.
		const fullRun = executions >= summary.plan.needed
		const DRAINED = 1_000_000n
		console.log(
			`\n[post-test] driving ${fullRun ? "the full sweep" : `${executions}`} of ${summary.plan.scheduled} executions…`,
		)
		const egressLimit = await breakerLimit(hyd)
		let peakBreaker = await breakerPercent(hyd, egressLimit)
		let completed = 0
		let sweptToCompletion = false

		for (let k = 1; k <= executions; k++) {
			const pre = await snapshot()
			if (pre.holderUsdt < DRAINED && pre.holderUsdc < DRAINED) {
				console.log(`  holder drained after ${completed} executions — sweep complete`)
				sweptToCompletion = true
				break
			}
			const before = { usdt: pre.treasuryUsdt, usdc: pre.treasuryUsdc }
			// Fire our task on Asset Hub (it XCMs the sweep to Hydration). The in-process HRMP hop is
			// awaited inside newBlock (connectHorizontal's subscription runs during setHead), so a
			// successful dispatch means the message is already queued on Hydration. Assert the dispatch
			// succeeded so a failed `PolkadotXcm.send` fails here, at the cause.
			const dispatch = await fireScheduledTask(ah, summary.schedulerTask.id)
			console.log(`  [${k}] Asset Hub dispatch result: ${jsonSafe(dispatch.result)}`)
			assert.ok(
				isRecord(dispatch.result) && dispatch.result.success === true,
				`execution ${k}: scheduler dispatched but the call failed on Asset Hub: ${jsonSafe(dispatch.result)}`,
			)

			// `connectHorizontal` delivers the sibling HRMP message by subscribing to Asset Hub's
			// `hrmpOutboundMessages` storage and, on change, queuing it onto Hydration — asynchronously,
			// a few seconds after the Asset Hub block. So wait for that callback to run, then advance
			// Hydration one interval slot-consistently (so the egress breaker decays as in production);
			// that block also processes the queued HRMP. Retry a few natural blocks if it hasn't landed.
			await advanceTime(hyd, summary.plan.intervalBlocks * RELAY_SLOT_MS)
			let outcome = await proxyOutcome(hyd)
			// The message is queued on Hydration during the Asset Hub build; allow a generous number of
			// natural blocks for its execution to land.
			for (let attempt = 0; attempt < 25 && !outcome.ok; attempt++) {
				await build(hyd)
				outcome = await proxyOutcome(hyd)
			}
			if (!outcome.ok) {
				// The failure message includes whether the message arrived at all and what the latest
				// Hydration block contained.
				const events = (await hyd.api.query.System.Events.getValue()) as Array<{
					event: { type: string; value: { type: string } }
				}>
				const names = events.map((e) => `${e.event.type}.${e.event.value.type}`).join(", ")
				assert.fail(
					`execution ${k}: proxied XTokens transfer ${outcome.seen ? "FAILED on Hydration" : "never executed on Hydration (message not delivered?)"}: ${outcome.error}; latest Hydration block events: [${names}]`,
				)
			}

			// Asset Hub receives the reserve withdrawal the same way (Hydration -> AH sibling HRMP).
			let afterUsdt = before.usdt
			for (let attempt = 0; attempt < 10 && afterUsdt <= before.usdt; attempt++) {
				await build(ah)
				afterUsdt = await treasury(usdt.assetHubAssetId)
			}

			const [breakerNow, afterUsdc] = await Promise.all([
				breakerPercent(hyd, egressLimit),
				treasury(usdc.assetHubAssetId),
			])
			peakBreaker = Math.max(peakBreaker, breakerNow)
			const after = { usdt: afterUsdt, usdc: afterUsdc }
			completed = k
			const label = fullRun ? `${k}` : `${k}/${executions}`
			console.log(
				`  [${label}] treasury +${fmt(after.usdt - before.usdt, 6, "USDT")} +${fmt(after.usdc - before.usdc, 6, "USDC")} (cumulative +${fmt(after.usdt - start.treasuryUsdt, 6, "USDT")} +${fmt(after.usdc - start.treasuryUsdc, 6, "USDC")}) | breaker ${peakBreaker.toFixed(1)}%`,
			)
			// The holder still held a full chunk before this execution, so it must have credited the treasury.
			assert.ok(
				after.usdt > before.usdt && after.usdc > before.usdc,
				`execution ${k}: treasury not credited (reserve withdrawal did not land on Asset Hub)`,
			)
		}

		// After the holder is drained the remaining (margin) executions still fire on schedule but move
		// nothing. Drive them to exhaust the periodic count and confirm the schedule actually ends — a
		// periodic task has no "finished" event, so completion is the named task leaving Scheduler.Lookup.
		let marginFired = 0
		let scheduleComplete = false
		if (fullRun && sweptToCompletion) {
			console.log(
				`\n[post-test] exhausting the schedule: firing the remaining margin executions (holder empty, expect no-ops)…`,
			)
			for (let m = completed + 1; m <= summary.plan.scheduled; m++) {
				if (!(await isTaskScheduled(ah, summary.schedulerTask.id))) break
				const [beforeUsdt, beforeUsdc] = await Promise.all([
					treasury(usdt.assetHubAssetId),
					treasury(usdc.assetHubAssetId),
				])
				const dispatch = await fireScheduledTask(ah, summary.schedulerTask.id)
				// The XCM is still delivered to Hydration — but with the holder empty the proxied
				// transfer must now FAIL there. Build fresh blocks (events are per-block, so the first
				// build also clears the previous margin run's event) until it executes, then assert both
				// halves: delivered, and rejected.
				let outcome: { seen: boolean; ok: boolean; error?: string } = { seen: false, ok: false }
				for (let attempt = 0; attempt < 25 && !outcome.seen; attempt++) {
					await build(hyd)
					outcome = await proxyOutcome(hyd)
				}
				assert.ok(outcome.seen, `margin execution ${m}: sweep XCM was not delivered to Hydration`)
				assert.ok(
					!outcome.ok,
					`margin execution ${m}: proxied transfer unexpectedly SUCCEEDED though the holder is empty`,
				)
				await flush(ah, 2)
				const [afterUsdt, afterUsdc] = await Promise.all([
					treasury(usdt.assetHubAssetId),
					treasury(usdc.assetHubAssetId),
				])
				assert.ok(
					afterUsdt === beforeUsdt && afterUsdc === beforeUsdc,
					`margin execution ${m} moved funds though the holder is empty`,
				)
				marginFired++
				console.log(
					`  [${m}] margin dispatch ${jsonSafe(dispatch.result)} — delivered to Hydration, transfer rejected as expected, no funds moved`,
				)
			}
			scheduleComplete = !(await isTaskScheduled(ah, summary.schedulerTask.id))
			console.log(
				`  fired ${marginFired} margin execution(s); scheduler task still present afterwards: ${!scheduleComplete}`,
			)
		}

		const end = await snapshot()
		const treasuryGainUsdt = end.treasuryUsdt - start.treasuryUsdt
		const treasuryGainUsdc = end.treasuryUsdc - start.treasuryUsdc
		const holderDropUsdt = start.holderUsdt - end.holderUsdt
		const holderDropUsdc = start.holderUsdc - end.holderUsdc

		console.log("\n[post-test] results")
		console.log(
			`  executions run  ${completed}${sweptToCompletion ? " (holder fully drained)" : ""}`,
		)
		if (fullRun) {
			console.log(
				`  margin runs     ${marginFired} fired (delivered to Hydration, transfer rejected, no funds moved); schedule ${scheduleComplete ? "complete — named task removed from Scheduler.Lookup" : "NOT complete (task still scheduled)"}`,
			)
		}
		console.log(
			`  treasury gained ${fmt(treasuryGainUsdt, 6, "USDT")} + ${fmt(treasuryGainUsdc, 6, "USDC")}`,
		)
		console.log(
			`  holder dropped  ${fmt(holderDropUsdt, 6, "USDT")} + ${fmt(holderDropUsdc, 6, "USDC")}`,
		)
		console.log(
			`  holder left     ${fmt(end.holderUsdt, 6, "USDT")} + ${fmt(end.holderUsdc, 6, "USDC")}`,
		)
		console.log(`  peak breaker    ${peakBreaker.toFixed(1)}% (cap ${maxBreakerPct}%)`)

		// `a` and `b` agree to within `1/tolFrac` (default 1%, i.e. tolFrac=100).
		const near = (aIn: bigint | number, bIn: bigint | number, tolFrac = 100n) => {
			const a = BigInt(aIn)
			const b = BigInt(bIn)
			const diff = a > b ? a - b : b - a
			return diff * tolFrac <= a
		}

		assert.ok(treasuryGainUsdt > 0n && treasuryGainUsdc > 0n, "treasury was not credited")
		assert.ok(holderDropUsdt > 0n && holderDropUsdc > 0n, "holder balance did not decrease")
		// Each execution's Asset Hub fee is tiny, so the treasury gain must be within 1% of the holder drop.
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
				"schedule did not complete: the named scheduler task is still present after all scheduled executions",
			)
			assert.ok(
				end.holderUsdt < DRAINED && end.holderUsdc < DRAINED,
				`holder not fully swept: ${fmt(end.holderUsdt, 6, "USDT")} + ${fmt(end.holderUsdc, 6, "USDC")} left`,
			)
			// The full sweep must land essentially all of the starting balance (within ~0.5%).
			assert.ok(
				near(treasuryGainUsdt, start.holderUsdt, 200n) &&
					near(treasuryGainUsdc, start.holderUsdc, 200n),
				"full run: treasury gain is not close to the holder's starting balance",
			)
		}
		console.log("\n[post-test] all assertions passed ✓")
	} finally {
		hyd.client.destroy()
		ah.client.destroy()
	}
}
