import { writeFileSync } from "node:fs"
import {
	TraitsScheduleDispatchTime,
	XcmV2OriginKind,
	XcmV3WeightLimit,
	XcmV5Instruction,
	XcmV5Junction,
	XcmV5Junctions,
	XcmVersionedLocation,
} from "@polkadot-api/descriptors"
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders"
import {
	AccountId,
	Blake2256,
	decAnyMetadata,
	unifyMetadata,
} from "@polkadot-api/substrate-bindings"
import { createClient } from "polkadot-api"
import { fromHex, toHex } from "polkadot-api/utils"
import { getWsProvider } from "polkadot-api/ws"
import { siblingSovereignAccount, toSs58 } from "./src/accounts.ts"
import { getTreasuryAccount } from "./src/assetHub.ts"
import { connectAssetHub, connectHydration, getOfflineApis } from "./src/chains.ts"
import {
	ASSET_HUB_PARA_ID,
	DEFAULT_ENDPOINTS,
	HYDRATION_SS58_PREFIX,
	POLKADOT_SS58_PREFIX,
	SCHEDULER_TASK_LABEL,
} from "./src/config.ts"
import { describeFootprint, quoteSweepEconomics } from "./src/footprint.ts"
import { getTokenBalance } from "./src/hydration.ts"
import { type AssetAmount, chunkForFootprint, planChunks } from "./src/plan.ts"
import { buildProposal, schedulerTaskId } from "./src/proposal.ts"
import { buildReferendumCalls } from "./src/referendum.ts"
import { buildTransactXcm, versionedXcm } from "./src/xcm.ts"

// biome-ignore lint/suspicious/noExplicitAny: runtime-decoded chain data.
type Any = any
const pk = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"))
const AH_SOVEREIGN_PUBKEY_HEX = `7369626ce803${"00".repeat(26)}`
const PARENT_PUBKEY_HEX = `506172656e74${"00".repeat(26)}`
const OLD_TREASURY_PUBKEY_PREFIX = "af3e7da2"
const LEGACY_PER_FIRING = 5_000_000_000n
const toHyd58 = (h: string) => AccountId(HYDRATION_SS58_PREFIX).dec(pk(h))
const hx = (v: Any): string =>
	v == null
		? ""
		: typeof v === "string"
			? v.replace(/^0x/, "")
			: typeof v?.asHex === "function"
				? v.asHex().replace(/^0x/, "")
				: v instanceof Uint8Array
					? Buffer.from(v).toString("hex")
					: ""
const bytesOf = (e: Any): Uint8Array =>
	e instanceof Uint8Array ? e : (e?.asOpaqueBytes?.() ?? e?.asBytes?.() ?? pk(e.asHex().slice(2)))

const PLAN_FOR: Record<string, { ref: string; mode: "chunked" | "single" | "leftover" }> = {
	c5b7975d: { ref: "1501", mode: "leftover" },
	"65feec15": { ref: "1729", mode: "chunked" },
	"853ad5c0": { ref: "457", mode: "single" },
	"471f9236": { ref: "1104", mode: "single" },
}

const track = ((): "root" | "whitelisted-caller" => {
	const i = process.argv.indexOf("--track")
	const value = i >= 0 ? (process.argv[i + 1] ?? "root") : "root"
	if (value !== "root" && value !== "whitelisted-caller")
		throw new Error(`--track must be root or whitelisted-caller, was "${value}"`)
	return value
})()

const offline = await getOfflineApis()
const endpointList = (override: string | undefined, fallback: readonly string[]): string[] =>
	override ? [override] : [...fallback]
const hyd = connectHydration(endpointList(process.env.HYD_ENDPOINT, DEFAULT_ENDPOINTS.hydration))
const ah = connectAssetHub(endpointList(process.env.AH_ENDPOINT, DEFAULT_ENDPOINTS.assetHub))
const relayClient = createClient(
	getWsProvider(
		endpointList(process.env.RELAY_ENDPOINT, [
			"wss://polkadot-rpc.n.dwellir.com",
			"wss://rpc.polkadot.io",
		]),
	),
)
const relay = relayClient.getUnsafeApi()

const sovereignKey = siblingSovereignAccount(ASSET_HUB_PARA_ID)
const sovereign = { ss58: toSs58(sovereignKey, HYDRATION_SS58_PREFIX), publicKey: sovereignKey }
const beneficiaryKey = await getTreasuryAccount(ah.api)
console.log(`sovereign 7LCt6: ${sovereign.ss58}`)
console.log(
	`current AH treasury: ${toSs58(beneficiaryKey, POLKADOT_SS58_PREFIX)}  0x${toHex(beneficiaryKey).slice(2)}`,
)

interface Sched {
	ref: string
	mode: "chunked" | "single" | "leftover"
	holderSs58: string
	holderHex: string
	slot: number
	index: number
	period: number
	hash: string
	len: number
	curUsdt: bigint
	curUsdc: bigint
	hasSov: boolean
}
const entries = await ah.api.query.Scheduler.Agenda.getEntries()
const scheds: Sched[] = []
for (const e of entries) {
	const items = e.value as Any[]
	for (let i = 0; i < items.length; i++) {
		const it = items[i]
		if (!it?.maybe_periodic || it.call?.type !== "Lookup") continue
		const hash = hx(it.call.value.hash)
		const len = Number(it.call.value.len)
		const preimage = await ah.api.query.Preimage.PreimageFor.getValue([`0x${hash}`, len] as Any)
		if (!preimage) continue
		const outerCall = (await ah.api.txFromCallData(bytesOf(preimage))).decodedCall
		if (outerCall.type !== "PolkadotXcm" || outerCall.value.type !== "send") continue
		const instructions: Any[] = (outerCall.value.value as Any).message.value
		const transact = instructions.find((x) => x?.type === "Transact")
		const transactCall = transact?.value?.call
		const innerCall = (await hyd.api.txFromCallData(bytesOf(transactCall?.encoded ?? transactCall)))
			.decodedCall
		if (innerCall.type !== "Proxy" || innerCall.value.type !== "proxy") continue
		const real = (innerCall.value.value as Any).real
		const holderSs58 = typeof real === "string" ? real : (real?.value ?? real)
		const holderHex = hx(AccountId(HYDRATION_SS58_PREFIX).enc(holderSs58))
		const conf = PLAN_FOR[holderHex.slice(0, 8)]
		if (!conf) {
			console.log(
				`  skip unknown periodic sweep holder ${holderHex.slice(0, 8)} (hash ${hash.slice(0, 8)})`,
			)
			continue
		}
		const xtokensCall = (innerCall.value.value as Any).call
		const dest: Any = xtokensCall?.value?.value?.dest
		const junctions = dest?.value?.interior?.value
		const account = Array.isArray(junctions)
			? junctions.find((j: Any) => j?.type === "AccountId32")
			: junctions?.type === "AccountId32"
				? junctions
				: undefined
		const destHex = hx(account?.value?.id)
		if (!destHex.startsWith(OLD_TREASURY_PUBKEY_PREFIX))
			console.warn(
				`  WARNING: ${conf.ref} dest is ${destHex.slice(0, 12)} (expected old ${OLD_TREASURY_PUBKEY_PREFIX})`,
			)
		const [u, c, prox] = await Promise.all([
			getTokenBalance(hyd.api, holderSs58, 10).then((b: Any) => b.free),
			getTokenBalance(hyd.api, holderSs58, 22).then((b: Any) => b.free),
			hyd.api.query.Proxy.Proxies.getValue(holderSs58).then((r: Any) =>
				(r?.[0] ?? []).map((d: Any) =>
					hx(
						AccountId(HYDRATION_SS58_PREFIX).enc(
							typeof d.delegate === "string" ? d.delegate : d.delegate,
						),
					),
				),
			),
		])
		scheds.push({
			ref: conf.ref,
			mode: conf.mode,
			holderSs58,
			holderHex,
			slot: Number(e.keyArgs[0]),
			index: i,
			period: Number(it.maybe_periodic[0]),
			hash,
			len,
			curUsdt: u,
			curUsdc: c,
			hasSov: (prox as string[]).some((d) => d.startsWith(AH_SOVEREIGN_PUBKEY_HEX.slice(0, 8))),
		})
	}
}
scheds.sort((a, b) => a.ref.localeCompare(b.ref))
console.log(`\ndecoded ${scheds.length} legacy schedules:`)
for (const s of scheds)
	console.log(
		`  #${s.ref} holder ${s.holderHex.slice(0, 8)} slot ${s.slot} idx ${s.index} period ${s.period} | ${Number(s.curUsdt) / 1e6} USDT + ${Number(s.curUsdc) / 1e6} USDC | AH-sov proxy: ${s.hasSov} | mode ${s.mode}`,
	)
if (scheds.length !== 4) throw new Error(`expected 4 legacy schedules, found ${scheds.length}`)

const cancelAtBlock = ((): number | undefined => {
	const iB = process.argv.indexOf("--cancel-at-block")
	if (iB >= 0 && process.argv[iB + 1]) {
		const b = Number(process.argv[iB + 1])
		if (!Number.isInteger(b))
			throw new Error(`--cancel-at-block: "${process.argv[iB + 1]}" is not an integer`)
		return b
	}
	const iO = process.argv.indexOf("--enact-offset")
	if (iO >= 0 && process.argv[iO + 1]) {
		const off = Number(process.argv[iO + 1])
		if (!Number.isInteger(off) || off <= 0)
			throw new Error("--enact-offset must be a positive integer")
		const maxSlot = Math.max(...scheds.map((s) => s.slot))
		let b = maxSlot + off
		while (scheds.some((s) => (b - s.slot) % s.period === 0)) b++
		console.log(`--enact-offset ${off}: enact At(${b}) (maxSlot ${maxSlot} + ${off}, off-grid)`)
		return b
	}
	return undefined
})()
const enactment =
	cancelAtBlock === undefined
		? TraitsScheduleDispatchTime.After(10)
		: TraitsScheduleDispatchTime.At(cancelAtBlock)
const whenFor = (s: Sched): number => {
	if (cancelAtBlock === undefined) return s.slot
	if (cancelAtBlock <= s.slot)
		throw new Error(`--cancel-at-block ${cancelAtBlock} must be > slot ${s.slot} (#${s.ref})`)
	if ((cancelAtBlock - s.slot) % s.period === 0)
		throw new Error(
			`--cancel-at-block ${cancelAtBlock} lands on #${s.ref}'s grid (slot ${s.slot} period ${s.period}); pick another B`,
		)
	return s.slot + s.period * Math.ceil((cancelAtBlock - s.slot) / s.period)
}

const INTERVAL = 600
const EXTRA = 16
const MAX_FOOTPRINT = 0.15
const BLOCK_MS = 6000
const FEE_BUDGET_PLANCK = 200_000_000n
const intervalMs = INTERVAL * BLOCK_MS
const baseFor = (holder: string) => ({
	holder,
	sovereign,
	beneficiary: beneficiaryKey,
	feeBudget: FEE_BUDGET_PLANCK,
	topUp: undefined,
	priority: 0,
	fallbackMaxWeight: undefined,
})

function leftover(s: Sched): [bigint, bigint] {
	const firings =
		s.curUsdt < s.curUsdc ? s.curUsdt / LEGACY_PER_FIRING : s.curUsdc / LEGACY_PER_FIRING
	return [s.curUsdt - firings * LEGACY_PER_FIRING, s.curUsdc - firings * LEGACY_PER_FIRING]
}

const addProxySends: Any[] = []
const cancelCalls: Any[] = []
const scheduleCalls: Any[] = []
const summaryTasks: Any[] = []

async function addProxySendFor(holderSs58: string): Promise<Any> {
	const addProxy = offline.hydration.tx.Proxy.add_proxy({
		delegate: toHyd58(AH_SOVEREIGN_PUBKEY_HEX),
		proxy_type: { type: "Any", value: undefined } as never,
		delay: 0,
	})
	const hydCall = offline.hydration.tx.Proxy.proxy({
		real: holderSs58,
		force_proxy_type: undefined,
		call: addProxy.decodedCall,
	})
	const relayToHyd = buildTransactXcm({
		feeBudget: 1_000_000_000n,
		call: hydCall.encodedData,
		fallbackMaxWeight: undefined,
		refundTo: pk(PARENT_PUBKEY_HEX),
	})
	const relaySend = relay.tx.XcmPallet.send({
		dest: XcmVersionedLocation.V5({
			parents: 0,
			interior: XcmV5Junctions.X1(XcmV5Junction.Parachain(2034)),
		}),
		message: versionedXcm(relayToHyd),
	})
	const relaySendBytes = bytesOf(await relaySend.getEncodedData())
	return offline.assetHub.tx.PolkadotXcm.send({
		dest: XcmVersionedLocation.V5({ parents: 1, interior: XcmV5Junctions.Here() }),
		message: versionedXcm([
			XcmV5Instruction.UnpaidExecution({
				weight_limit: XcmV3WeightLimit.Unlimited(),
				check_origin: undefined,
			}),
			XcmV5Instruction.Transact({
				origin_kind: XcmV2OriginKind.Superuser(),
				fallback_max_weight: undefined,
				call: relaySendBytes,
			}),
		]),
	})
}

for (const s of scheds) {
	const [usdt, usdc] = s.mode === "leftover" ? leftover(s) : [s.curUsdt, s.curUsdc]
	const assets: AssetAmount[] = [
		{ symbol: "USDT", hydrationAssetId: 10, assetHubAssetId: 1984n, decimals: 6, amount: usdt },
		{ symbol: "USDC", hydrationAssetId: 22, assetHubAssetId: 1337n, decimals: 6, amount: usdc },
	]
	let plan = planChunks(assets, usdt > usdc ? usdt : usdc, INTERVAL, 0)
	if (s.mode === "chunked") {
		const draft = buildProposal(offline, { ...baseFor(s.holderSs58), plan })
		const econ = await quoteSweepEconomics(
			hyd.api,
			versionedXcm(draft.periodic.instructions),
			assets[0].assetHubAssetId,
		)
		if (econ.limitUnits === undefined || econ.windowMs === undefined)
			throw new Error("cannot size the chunk: Hydration egress limit / HDX price unavailable")
		const chunk = chunkForFootprint(assets, {
			limitUnits: econ.limitUnits,
			share: MAX_FOOTPRINT,
			intervalMs,
			windowMs: econ.windowMs,
		})
		plan = planChunks(assets, chunk, INTERVAL, EXTRA)
		for (const line of describeFootprint(
			plan,
			econ.limitUnits,
			econ.windowMs,
			intervalMs,
			MAX_FOOTPRINT,
		))
			console.log(`  #${s.ref} ${line}`)
	}
	const prop = buildProposal(offline, { ...baseFor(s.holderSs58), plan })
	const taskId = schedulerTaskId(`${SCHEDULER_TASK_LABEL}:${s.ref}`)
	scheduleCalls.push(
		offline.assetHub.tx.Scheduler.schedule_named_after({
			id: taskId,
			after: prop.periodic.every,
			maybe_periodic: plan.scheduled > 1 ? [prop.periodic.every, plan.scheduled] : undefined,
			priority: 0,
			call: prop.periodic.send.decodedCall,
		}).decodedCall,
	)
	const when = whenFor(s)
	cancelCalls.push(offline.assetHub.tx.Scheduler.cancel({ when, index: s.index }).decodedCall)
	if (!s.hasSov) addProxySends.push((await addProxySendFor(s.holderSs58)).decodedCall)
	console.log(
		`  #${s.ref} ${s.mode}: move ${Number(usdt) / 1e6}+${Number(usdc) / 1e6} in ${plan.needed} exec(s); cancel (when ${when}, idx ${s.index})${s.hasSov ? "" : "; +add-proxy"}; task ${taskId.slice(0, 10)}`,
	)
	summaryTasks.push({
		ref: s.ref,
		mode: s.mode,
		holder: s.holderHex,
		oldPreimagePrefix: s.hash.slice(0, 8),
		newTaskId: taskId,
		addProxy: !s.hasSov,
		cancel: { when, index: s.index, slot: s.slot, period: s.period },
		plan: { intervalBlocks: plan.intervalBlocks, needed: plan.needed, scheduled: plan.scheduled },
		amounts: { usdt: usdt.toString(), usdc: usdc.toString() },
	})
}

const batch = offline.assetHub.tx.Utility.batch_all({
	calls: [...addProxySends, ...cancelCalls, ...scheduleCalls],
})
console.log(
	`\nbatch_all: ${addProxySends.length} add-proxy + ${cancelCalls.length} cancel + ${scheduleCalls.length} schedule = ${batch.encodedData.length} bytes, hash 0x${toHex(Blake2256(batch.encodedData)).slice(2)}`,
)
const ref = buildReferendumCalls(
	{ assetHub: offline.assetHub, collectives: offline.collectives },
	batch,
	track,
	enactment,
)
writeFileSync("out/all-preimage.call", toHex(ref.preimageForPublicReferendum.encodedData))
writeFileSync("out/all-submit.call", toHex(ref.publicReferendumSubmission.encodedData))
writeFileSync(
	"out/summary-all.json",
	JSON.stringify(
		{
			track: ref.track,
			sovereignAccountOnHydration: sovereign.ss58,
			beneficiary: toSs58(beneficiaryKey, POLKADOT_SS58_PREFIX),
			delegateToAdd: AH_SOVEREIGN_PUBKEY_HEX,
			enactAtBlock: cancelAtBlock ?? null,
			tasks: summaryTasks,
		},
		null,
		2,
	),
)
console.log(`\ntrack: ${ref.track}`)
console.log(
	`wrote out/all-preimage.call (${ref.preimageForPublicReferendum.length}B, hash ${ref.preimageForPublicReferendum.hash})`,
)
console.log(`wrote out/all-submit.call (${ref.publicReferendumSubmission.length}B)`)
if (ref.track === "whitelisted-caller" && ref.fellowshipReferendumSubmission) {
	writeFileSync(
		"out/all-fellowship-submit.call",
		toHex(ref.fellowshipReferendumSubmission.encodedData),
	)
	console.log(
		`wrote out/all-fellowship-submit.call (${ref.fellowshipReferendumSubmission.length}B)`,
	)
	if (ref.preimageForWhitelistCall) {
		writeFileSync(
			"out/all-fellowship-preimage.call",
			toHex(ref.preimageForWhitelistCall.encodedData),
		)
		console.log(`wrote out/all-fellowship-preimage.call (${ref.preimageForWhitelistCall.length}B)`)
	}
}
console.log("wrote out/summary-all.json")

if (cancelAtBlock !== undefined) {
	const metaHex = await ah.client._request<string, []>("state_getMetadata", [])
	const agenda = getDynamicBuilder(
		getLookupFn(unifyMetadata(decAnyMetadata(fromHex(metaHex)))),
	).buildStorage("Scheduler", "Agenda")
	const byWhen = new Map<number, { raw: string; items: Any[] }>()
	const slotsToClear = new Set<number>()
	for (const s of scheds) {
		const raw = await ah.client._request<string, [string]>("state_getStorage", [
			agenda.keys.enc(s.slot),
		])
		const vec = agenda.value.dec(raw) as Any[]
		const entry = vec[s.index]
		const when = whenFor(s)
		slotsToClear.add(s.slot)
		slotsToClear.add(s.slot + s.period)
		const group = byWhen.get(when) ?? { raw, items: [] }
		group.items[s.index] = entry
		byWhen.set(when, group)
	}
	const lines = ["import-storage:", "  Scheduler:", "    Agenda:"]
	for (const [when, group] of byWhen) {
		const filled = Array.from(group.items, (x) => x ?? null)
		lines.push(`      - - [${when}]`, `        - '${toHex(agenda.value.enc(filled))}'`)
	}
	for (const slot of slotsToClear)
		if (!byWhen.has(slot)) lines.push(`      - - [${slot}]`, "        - null")
	const ahEndpoint = process.env.AH_ENDPOINT ?? DEFAULT_ENDPOINTS.assetHub[0]
	writeFileSync("out/all-ah-sim.yml", [`endpoint: '${ahEndpoint}'`, ...lines, ""].join("\n"))
	console.log(`wrote out/all-ah-sim.yml (relocated ${scheds.length} tasks; endpoint ${ahEndpoint})`)
}

const reduceChunkedTo = ((): bigint | undefined => {
	const i = process.argv.indexOf("--reduce-chunked")
	if (i < 0 || !process.argv[i + 1]) return undefined
	const n = Number(process.argv[i + 1])
	if (!Number.isFinite(n) || n <= 0)
		throw new Error("--reduce-chunked must be a positive 6-dp token amount")
	return BigInt(Math.round(n * 1e6))
})()
if (reduceChunkedTo !== undefined) {
	const chunked = scheds.find((s) => s.mode === "chunked")
	if (!chunked) throw new Error("--reduce-chunked: no chunked schedule among the four")
	const hydEndpoint = process.env.HYD_ENDPOINT ?? DEFAULT_ENDPOINTS.hydration[0]
	const tokenEntry = (id: number) =>
		`      - - ['${chunked.holderSs58}', ${id}]\n        - free: '${reduceChunkedTo}'\n          reserved: '0'\n          frozen: '0'`
	writeFileSync(
		"out/hyd-reduce.yml",
		[
			`endpoint: '${hydEndpoint}'`,
			"import-storage:",
			"  Tokens:",
			"    Accounts:",
			tokenEntry(10),
			tokenEntry(22),
			"",
		].join("\n"),
	)
	console.log(
		`wrote out/hyd-reduce.yml (chunked holder ${chunked.holderHex.slice(0, 8)} -> ${Number(reduceChunkedTo) / 1e6} USDT+USDC)`,
	)
}

relayClient.destroy()
hyd.client.destroy()
ah.client.destroy()
process.exit(0)
