import { setStorage, timeTravel } from "@acala-network/chopsticks-core"
import { createClient, type PolkadotClient } from "polkadot-api"
import { getWsProvider } from "polkadot-api/ws"
import { toHexString } from "../src/hex.ts"
import { isRecord } from "../src/verify.ts"

// biome-ignore lint/suspicious/noExplicitAny: getUnsafeApi() is untyped
export type Any = any

export interface Blockchain {
	newBlock(params?: {
		transactions?: string[]
		relayParentNumber?: number
		unsafeBlockHeight?: number
		relayChainStateOverrides?: Array<[string, string]>
	}): Promise<unknown>
	head?: { hash: string; number: number }
}
export interface PostTestChain {
	label: string
	specName: string
	kind?: string
	wsEndpoint: string
	chain: unknown
}
export interface PostTestContext {
	main: PostTestChain
	chains: PostTestChain[]
	args: unknown
}
export interface Chain {
	client: PolkadotClient
	api: Any
	bc: Blockchain
	slotMs: number
	label: string
}
export interface DispatchResult {
	result: unknown
}
export interface ProxyOutcome {
	seen: boolean
	ok: boolean
	error?: string
}
interface EventRecord {
	phase?: { type: string; value?: unknown }
	event: { type: string; value: { type: string; value: unknown } }
}

export const OP_TIMEOUT_MS = 300_000
export const RELAY_SLOT_MS = 6000
const RELAY_CURRENT_SLOT_KEY = "0x1cb6f36e027abb2091cfb5110ab5087f06155b3cd9a8c9e5e9a23fd5dc13a5ed"

let showBlockDetails = true
export function setBlockDetails(on: boolean): void {
	showBlockDetails = on
}
export function blockDetailsEnabled(): boolean {
	return showBlockDetails
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms).unref(),
		),
	])
}

export async function connect(meta: PostTestChain): Promise<Chain> {
	if (!meta.chain) throw new Error(`no chopsticks Blockchain object passed for ${meta.label}`)
	const client = createClient(getWsProvider(meta.wsEndpoint))
	const api = client.getUnsafeApi() as Any
	let slotMs = RELAY_SLOT_MS
	try {
		slotMs = Number(await api.constants.Aura.SlotDuration())
	} catch {
		slotMs = RELAY_SLOT_MS
	}
	return { client, api, bc: meta.chain as Blockchain, slotMs, label: meta.label }
}

export const jsonSafe = (value: unknown) =>
	JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))

export async function printBlockDetails(chain: Chain): Promise<void> {
	const head = chain.bc.head
	const number = head?.number ?? Number(await chain.api.query.System.Number.getValue())
	const events = (await chain.api.query.System.Events.getValue()) as EventRecord[]
	const hash = head?.hash ? ` ${head.hash}` : ""
	console.log(
		`  ┌ ${chain.label} block #${number.toLocaleString("en-US")}${hash} (${events.length} events)`,
	)
	for (const { phase, event } of events) {
		const origin =
			phase?.type === "ApplyExtrinsic" ? `ext#${phase.value}` : (phase?.type ?? "?").toLowerCase()
		const payload = jsonSafe(event.value.value) ?? ""
		const shown = payload.length > 140 ? `${payload.slice(0, 140)}…` : payload
		console.log(`  │  [${origin}] ${event.type}.${event.value.type}${shown ? ` ${shown}` : ""}`)
	}
	console.log("  └")
}

export async function build(chain: Chain): Promise<void> {
	await withTimeout(chain.bc.newBlock(), OP_TIMEOUT_MS, `newBlock ${chain.label}`)
	if (showBlockDetails) await printBlockDetails(chain)
}

export async function flush(chain: Chain, blockCount: number): Promise<void> {
	for (let built = 0; built < blockCount; built++) await build(chain)
}

function encodeU64Le(value: bigint): string {
	const bytes = new Uint8Array(8)
	new DataView(bytes.buffer).setBigUint64(0, value, true)
	return `0x${Buffer.from(bytes).toString("hex")}`
}

export async function advanceTime(chain: Chain, deltaMs: number): Promise<void> {
	const [now, relayParent] = await Promise.all([
		chain.api.query.Timestamp.Now.getValue(),
		chain.api.query.ParachainSystem.LastRelayChainBlockNumber.getValue(),
	])
	const targetMs = Number(now) + deltaMs
	await withTimeout(
		timeTravel(chain.bc as never, targetMs - chain.slotMs),
		OP_TIMEOUT_MS,
		"timeTravel",
	)
	await withTimeout(
		chain.bc.newBlock({
			relayParentNumber: Number(relayParent) + Math.round(deltaMs / RELAY_SLOT_MS),
			relayChainStateOverrides: [
				[RELAY_CURRENT_SLOT_KEY, encodeU64Le(BigInt(Math.floor(targetMs / RELAY_SLOT_MS)))],
			],
		}),
		OP_TIMEOUT_MS,
		"newBlock(advanceTime)",
	)
	if (showBlockDetails) await printBlockDetails(chain)
}

export async function setStore(chain: Chain, values: Any): Promise<void> {
	await withTimeout(setStorage(chain.bc as never, values), OP_TIMEOUT_MS, "setStorage")
}

export function field(item: Any, ...keys: string[]): Any {
	for (const key of keys) if (item?.[key] !== undefined) return item[key]
	return undefined
}

export function toStorageAgendaItem(item: Any): unknown {
	const call = item.call
	const storageCall =
		call?.type === "Inline"
			? { inline: toHexString(call.value) }
			: call?.type === "Lookup"
				? { lookup: { hash: toHexString(call.value.hash), len: call.value.len } }
				: call
	const originType = item.origin?.type
	const origin = originType
		? { [String(originType).toLowerCase()]: item.origin.value?.type ?? item.origin.value }
		: item.origin
	return {
		maybeId: toHexString(field(item, "maybeId", "maybe_id")) ?? null,
		priority: item.priority,
		call: storageCall,
		maybePeriodic: field(item, "maybePeriodic", "maybe_periodic") ?? null,
		origin,
	}
}

async function dispatchResultFor(
	assetHub: Chain,
	taskId: string,
): Promise<DispatchResult | undefined> {
	const events = (await assetHub.api.query.System.Events.getValue()) as EventRecord[]
	const dispatched = events.find(
		(record) =>
			record.event.type === "Scheduler" &&
			record.event.value.type === "Dispatched" &&
			isRecord(record.event.value.value) &&
			toHexString((record.event.value.value as { id?: unknown }).id) === taskId,
	)
	if (!dispatched || !isRecord(dispatched.event.value.value)) return undefined
	return { result: (dispatched.event.value.value as { result?: unknown }).result }
}

export async function fireScheduledTask(assetHub: Chain, taskId: string): Promise<DispatchResult> {
	const entries = await assetHub.api.query.Scheduler.Agenda.getEntries()
	let fromBlock: number | undefined
	let items: unknown
	for (const entry of entries) {
		const list = entry.value as unknown[]
		const hasTask = list?.some(
			(item) => isRecord(item) && toHexString(field(item, "maybeId", "maybe_id")) === taskId,
		)
		if (hasTask) {
			fromBlock = Number(entry.keyArgs[0])
			items = list
			break
		}
	}
	if (fromBlock === undefined) throw new Error(`scheduled task ${taskId} not found in the agenda`)
	const target = Number(
		await assetHub.api.query.ParachainSystem.LastRelayChainBlockNumber.getValue(),
	)
	const storageItems = (items as Any[]).map(toStorageAgendaItem)
	await setStore(assetHub, {
		Scheduler: {
			Agenda: [
				[[fromBlock], null],
				[[target], storageItems],
			],
			IncompleteSince: target,
		},
	})
	const lookup = await assetHub.api.query.Scheduler.Lookup.getValue(taskId).catch(() => undefined)
	if (lookup) await setStore(assetHub, { Scheduler: { Lookup: [[[taskId], [target, 0]]] } })
	for (let attempt = 0; attempt < 3; attempt++) {
		await build(assetHub)
		const dispatch = await dispatchResultFor(assetHub, taskId)
		if (dispatch) return dispatch
	}
	throw new Error(`scheduler did not dispatch task ${taskId} after relocation`)
}

export async function fireAgendaSlot(
	assetHub: Chain,
	slot: number,
): Promise<{ target: number; schedulerEvents: Any[] }> {
	const items = await assetHub.api.query.Scheduler.Agenda.getValue(slot)
	if (!Array.isArray(items) || items.length === 0) throw new Error(`agenda slot ${slot} is empty`)
	const target = Number(
		await assetHub.api.query.ParachainSystem.LastRelayChainBlockNumber.getValue(),
	)
	await setStore(assetHub, {
		Scheduler: {
			Agenda: [
				[[slot], null],
				[[target], (items as Any[]).map(toStorageAgendaItem)],
			],
			IncompleteSince: target,
		},
	})
	for (let attempt = 0; attempt < 3; attempt++) {
		await build(assetHub)
		const events = (await assetHub.api.query.System.Events.getValue()) as EventRecord[]
		const schedulerEvents = events
			.filter((record) => record.event.type === "Scheduler")
			.map((record) => record.event.value)
			.filter((value: Any) => Number(value?.value?.task?.[0]) === target)
		if (schedulerEvents.length > 0) return { target, schedulerEvents }
	}
	throw new Error(`scheduler did not service the relocated agenda slot ${slot}`)
}

export async function isTaskScheduled(assetHub: Chain, taskId: string): Promise<boolean> {
	const lookup = await assetHub.api.query.Scheduler.Lookup.getValue(taskId).catch(() => undefined)
	return lookup !== undefined && lookup !== null
}

export async function proxyOutcome(chain: Chain): Promise<ProxyOutcome> {
	const events = (await chain.api.query.System.Events.getValue()) as EventRecord[]
	const proxyExecuted = events.find(
		(record) => record.event.type === "Proxy" && record.event.value.type === "ProxyExecuted",
	)
	if (!proxyExecuted) return { seen: false, ok: false, error: "no Proxy.ProxyExecuted event" }
	const result = isRecord(proxyExecuted.event.value.value)
		? proxyExecuted.event.value.value.result
		: undefined
	if (isRecord(result) && result.success === true) return { seen: true, ok: true }
	return { seen: true, ok: false, error: jsonSafe(result) }
}
