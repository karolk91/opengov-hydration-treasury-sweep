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
import { siblingSovereignAccount, toSs58 } from "./accounts.ts"
import { getTreasuryAccount } from "./assetHub.ts"
import { connectAssetHub, connectHydration, getOfflineApis } from "./chains.ts"
import {
	ASSET_HUB_PARA_ID,
	DEFAULT_ENDPOINTS,
	HYDRATION_SS58_PREFIX,
	POLKADOT_SS58_PREFIX,
	SCHEDULER_TASK_LABEL,
} from "./config.ts"
import { describeFootprint, quoteSweepEconomics } from "./footprint.ts"
import { hexToBytes, hexWithoutPrefix, toBytes } from "./hex.ts"
import { getTokenBalance, quoteXcmFees } from "./hydration.ts"
import { type AssetAmount, chunkForFootprint, planChunks } from "./plan.ts"
import { buildProposal, schedulerTaskId } from "./proposal.ts"
import { buildReferendumCalls } from "./referendum.ts"
import { buildMultiTransactXcm, DOT_LOCATION, versionedXcm } from "./xcm.ts"

// biome-ignore lint/suspicious/noExplicitAny: runtime-decoded chain data
type Any = any

type SweepMode = "chunked" | "single" | "leftover"
interface LegacySchedule {
	ref: string
	mode: SweepMode
	holderSs58: string
	holderHex: string
	slot: number
	index: number
	period: number
	hash: string
	usdtBalance: bigint
	usdcBalance: bigint
	hasSovereignProxy: boolean
}

const AH_SOVEREIGN_PUBKEY_HEX = `7369626ce803${"00".repeat(26)}`
const PARENT_PUBKEY_HEX = `506172656e74${"00".repeat(26)}`
const OLD_TREASURY_PUBKEY_PREFIX = "af3e7da2"
const LEGACY_PER_FIRING = 5_000_000_000n
const USDT_HYDRATION = 10
const USDC_HYDRATION = 22
const HYDRATION_PARA_ID = 2034
const INTERVAL = 600
const EXTRA = 16
const MAX_FOOTPRINT = 0.15
const BLOCK_MS = 6000
const SWEEP_FEE_BUDGET_PLANCK = 1_000_000_000n
const ADD_PROXY_FEE_BUDGET_PLANCK = 1_000_000_000n
const DOT_PLANCK_PER_DOT = 10_000_000_000n
const intervalMs = INTERVAL * BLOCK_MS
const formatDot = (planck: bigint) =>
	`${(Number(planck) / Number(DOT_PLANCK_PER_DOT)).toFixed(6)} DOT`

const PLAN_FOR: Record<string, { ref: string; mode: SweepMode }> = {
	c5b7975d: { ref: "1501", mode: "leftover" },
	"65feec15": { ref: "1729", mode: "chunked" },
	"853ad5c0": { ref: "457", mode: "single" },
	"471f9236": { ref: "1104", mode: "single" },
}

const toHydrationAddress = (pubkeyHex: string) =>
	AccountId(HYDRATION_SS58_PREFIX).dec(hexToBytes(pubkeyHex))

const argValue = (flag: string): string | undefined => {
	const position = process.argv.indexOf(flag)
	return position >= 0 ? process.argv[position + 1] : undefined
}

const track = ((): "root" | "whitelisted-caller" => {
	const value = argValue("--track") ?? "root"
	if (value !== "root" && value !== "whitelisted-caller")
		throw new Error(`--track must be root or whitelisted-caller, was "${value}"`)
	return value
})()

const offline = await getOfflineApis()
const endpointList = (override: string | undefined, fallback: readonly string[]): string[] =>
	override ? [override] : [...fallback]
const hydration = connectHydration(
	endpointList(process.env.HYD_ENDPOINT, DEFAULT_ENDPOINTS.hydration),
)
const assetHub = connectAssetHub(endpointList(process.env.AH_ENDPOINT, DEFAULT_ENDPOINTS.assetHub))
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
const beneficiaryKey = await getTreasuryAccount(assetHub.api)
console.log(`sovereign 7LCt6: ${sovereign.ss58}`)
console.log(
	`current AH treasury: ${toSs58(beneficiaryKey, POLKADOT_SS58_PREFIX)}  0x${toHex(beneficiaryKey).slice(2)}`,
)

const agendaEntries = await assetHub.api.query.Scheduler.Agenda.getEntries()
const schedules: LegacySchedule[] = []
for (const entry of agendaEntries) {
	const items = entry.value as Any[]
	for (let index = 0; index < items.length; index++) {
		const item = items[index]
		if (!item?.maybe_periodic || item.call?.type !== "Lookup") continue
		const hash = hexWithoutPrefix(item.call.value.hash)
		const length = Number(item.call.value.len)
		const preimage = await assetHub.api.query.Preimage.PreimageFor.getValue([
			`0x${hash}`,
			length,
		] as Any)
		if (!preimage) continue
		const outerCall = (await assetHub.api.txFromCallData(toBytes(preimage))).decodedCall
		if (outerCall.type !== "PolkadotXcm" || outerCall.value.type !== "send") continue
		const instructions: Any[] = (outerCall.value.value as Any).message.value
		const transact = instructions.find((instruction) => instruction?.type === "Transact")
		const transactCall = transact?.value?.call
		if (!transactCall) continue
		const innerCall = (await hydration.api.txFromCallData(toBytes(transactCall))).decodedCall
		if (innerCall.type !== "Proxy" || innerCall.value.type !== "proxy") continue
		const real = (innerCall.value.value as Any).real
		const holderSs58 = typeof real === "string" ? real : (real?.value ?? real)
		const holderHex = hexWithoutPrefix(AccountId(HYDRATION_SS58_PREFIX).enc(holderSs58))
		const planEntry = PLAN_FOR[holderHex.slice(0, 8)]
		if (!planEntry) {
			console.log(
				`  skip unknown periodic sweep holder ${holderHex.slice(0, 8)} (hash ${hash.slice(0, 8)})`,
			)
			continue
		}
		const xtokensCall = (innerCall.value.value as Any).call
		const destination: Any = xtokensCall?.value?.value?.dest
		const junctions = destination?.value?.interior?.value
		const destinationAccount = Array.isArray(junctions)
			? junctions.find((junction: Any) => junction?.type === "AccountId32")
			: junctions?.type === "AccountId32"
				? junctions
				: undefined
		const destinationHex = hexWithoutPrefix(destinationAccount?.value?.id)
		if (!destinationHex.startsWith(OLD_TREASURY_PUBKEY_PREFIX))
			console.warn(
				`  WARNING: ${planEntry.ref} dest is ${destinationHex.slice(0, 12)} (expected old ${OLD_TREASURY_PUBKEY_PREFIX})`,
			)
		const [usdtBalance, usdcBalance, delegateHexes] = await Promise.all([
			getTokenBalance(hydration.api, holderSs58, USDT_HYDRATION).then(
				(balance: Any) => balance.free,
			),
			getTokenBalance(hydration.api, holderSs58, USDC_HYDRATION).then(
				(balance: Any) => balance.free,
			),
			hydration.api.query.Proxy.Proxies.getValue(holderSs58).then((proxies: Any) =>
				(proxies?.[0] ?? []).map((definition: Any) =>
					hexWithoutPrefix(AccountId(HYDRATION_SS58_PREFIX).enc(definition.delegate)),
				),
			),
		])
		schedules.push({
			ref: planEntry.ref,
			mode: planEntry.mode,
			holderSs58,
			holderHex,
			slot: Number(entry.keyArgs[0]),
			index,
			period: Number(item.maybe_periodic[0]),
			hash,
			usdtBalance,
			usdcBalance,
			hasSovereignProxy: (delegateHexes as string[]).some((delegateHex) =>
				delegateHex.startsWith(AH_SOVEREIGN_PUBKEY_HEX.slice(0, 8)),
			),
		})
	}
}
schedules.sort((first, second) => first.ref.localeCompare(second.ref))
console.log(`\ndecoded ${schedules.length} legacy schedules:`)
for (const schedule of schedules)
	console.log(
		`  #${schedule.ref} holder ${schedule.holderHex.slice(0, 8)} slot ${schedule.slot} idx ${schedule.index} period ${schedule.period} | ${Number(schedule.usdtBalance) / 1e6} USDT + ${Number(schedule.usdcBalance) / 1e6} USDC | AH-sov proxy: ${schedule.hasSovereignProxy} | mode ${schedule.mode}`,
	)
if (schedules.length !== 4)
	throw new Error(`expected 4 legacy schedules, found ${schedules.length}`)

const cancelAtBlock = ((): number | undefined => {
	const atBlockArg = argValue("--cancel-at-block")
	if (atBlockArg) {
		const block = Number(atBlockArg)
		if (!Number.isInteger(block))
			throw new Error(`--cancel-at-block: "${atBlockArg}" is not an integer`)
		return block
	}
	const offsetArg = argValue("--enact-offset")
	if (offsetArg) {
		const offset = Number(offsetArg)
		if (!Number.isInteger(offset) || offset <= 0)
			throw new Error("--enact-offset must be a positive integer")
		const maxSlot = Math.max(...schedules.map((schedule) => schedule.slot))
		let block = maxSlot + offset
		while (schedules.some((schedule) => (block - schedule.slot) % schedule.period === 0)) block++
		console.log(
			`--enact-offset ${offset}: enact At(${block}) (maxSlot ${maxSlot} + ${offset}, off-grid)`,
		)
		return block
	}
	return undefined
})()
const enactment =
	cancelAtBlock === undefined
		? TraitsScheduleDispatchTime.After(10)
		: TraitsScheduleDispatchTime.At(cancelAtBlock)
const whenFor = (schedule: LegacySchedule): number => {
	if (cancelAtBlock === undefined) return schedule.slot
	if (cancelAtBlock <= schedule.slot)
		throw new Error(
			`--cancel-at-block ${cancelAtBlock} must be > slot ${schedule.slot} (#${schedule.ref})`,
		)
	if ((cancelAtBlock - schedule.slot) % schedule.period === 0)
		throw new Error(
			`--cancel-at-block ${cancelAtBlock} is on #${schedule.ref}'s grid (slot ${schedule.slot} period ${schedule.period}); pick another B`,
		)
	return (
		schedule.slot + schedule.period * Math.ceil((cancelAtBlock - schedule.slot) / schedule.period)
	)
}

const proposalParamsFor = (holder: string) => ({
	holder,
	sovereign,
	beneficiary: beneficiaryKey,
	feeBudget: SWEEP_FEE_BUDGET_PLANCK,
	topUp: undefined,
	priority: 0,
	fallbackMaxWeight: undefined,
})

function leftover(schedule: LegacySchedule): [bigint, bigint] {
	const smaller =
		schedule.usdtBalance < schedule.usdcBalance ? schedule.usdtBalance : schedule.usdcBalance
	const firings = smaller / LEGACY_PER_FIRING
	return [
		schedule.usdtBalance - firings * LEGACY_PER_FIRING,
		schedule.usdcBalance - firings * LEGACY_PER_FIRING,
	]
}

const cancelCalls: Any[] = []
const scheduleCalls: Any[] = []
const summaryTasks: Any[] = []
const holdersNeedingProxy: string[] = []
const feeQuotes: Array<{
	leg: string
	quotedPlanck: bigint
	budgetPlanck: bigint
	executions: number
}> = []
const dotFeeAsset = new Map([["DOT", DOT_LOCATION]])

async function quoteLeg(
	leg: string,
	instructions: Any[],
	budgetPlanck: bigint,
	executions: number,
) {
	const quote = await quoteXcmFees(hydration.api, versionedXcm(instructions), dotFeeAsset)
	const quotedPlanck = quote.fees.get("DOT")
	if (quotedPlanck === undefined) throw new Error(`Hydration cannot price the ${leg} XCM in DOT`)
	if (budgetPlanck < quotedPlanck * 2n)
		throw new Error(
			`${leg}: fee budget ${formatDot(budgetPlanck)} is below twice the quoted fee ${formatDot(quotedPlanck)}`,
		)
	feeQuotes.push({ leg, quotedPlanck, budgetPlanck, executions })
}

async function addProxySendFor(holderAddresses: readonly string[]): Promise<Any> {
	const addProxy = offline.hydration.tx.Proxy.add_proxy({
		delegate: toHydrationAddress(AH_SOVEREIGN_PUBKEY_HEX),
		proxy_type: { type: "Any", value: undefined } as never,
		delay: 0,
	})
	const proxiedCalls = holderAddresses.map(
		(holderAddress) =>
			offline.hydration.tx.Proxy.proxy({
				real: holderAddress,
				force_proxy_type: undefined,
				call: addProxy.decodedCall,
			}).encodedData,
	)
	const relayToHydration = buildMultiTransactXcm({
		feeBudget: ADD_PROXY_FEE_BUDGET_PLANCK,
		calls: proxiedCalls,
		fallbackMaxWeight: undefined,
		refundTo: hexToBytes(PARENT_PUBKEY_HEX),
	})
	await quoteLeg(
		`add-proxy (${holderAddresses.length} Transacts)`,
		relayToHydration,
		ADD_PROXY_FEE_BUDGET_PLANCK,
		1,
	)
	const relayXcmPallet = relay.tx.XcmPallet
	if (!relayXcmPallet?.send) throw new Error("relay runtime has no XcmPallet.send")
	const relaySend = relayXcmPallet.send({
		dest: XcmVersionedLocation.V5({
			parents: 0,
			interior: XcmV5Junctions.X1(XcmV5Junction.Parachain(HYDRATION_PARA_ID)),
		}),
		message: versionedXcm(relayToHydration),
	})
	const relaySendBytes = toBytes(await relaySend.getEncodedData())
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

for (const schedule of schedules) {
	const [usdt, usdc] =
		schedule.mode === "leftover" ? leftover(schedule) : [schedule.usdtBalance, schedule.usdcBalance]
	const usdtAsset: AssetAmount = {
		symbol: "USDT",
		hydrationAssetId: USDT_HYDRATION,
		assetHubAssetId: 1984n,
		decimals: 6,
		amount: usdt,
	}
	const usdcAsset: AssetAmount = {
		symbol: "USDC",
		hydrationAssetId: USDC_HYDRATION,
		assetHubAssetId: 1337n,
		decimals: 6,
		amount: usdc,
	}
	const assets: AssetAmount[] = [usdtAsset, usdcAsset]
	let plan = planChunks(assets, usdt > usdc ? usdt : usdc, INTERVAL, 0)
	if (schedule.mode === "chunked") {
		const draft = buildProposal(offline, { ...proposalParamsFor(schedule.holderSs58), plan })
		const economics = await quoteSweepEconomics(
			hydration.api,
			versionedXcm(draft.periodic.instructions),
			usdtAsset.assetHubAssetId,
		)
		if (economics.limitUnits === undefined || economics.windowMs === undefined)
			throw new Error("cannot size the chunk: Hydration egress limit / HDX price unavailable")
		const chunk = chunkForFootprint(assets, {
			limitUnits: economics.limitUnits,
			share: MAX_FOOTPRINT,
			intervalMs,
			windowMs: economics.windowMs,
		})
		plan = planChunks(assets, chunk, INTERVAL, EXTRA)
		for (const line of describeFootprint(
			plan,
			economics.limitUnits,
			economics.windowMs,
			intervalMs,
			MAX_FOOTPRINT,
		))
			console.log(`  #${schedule.ref} ${line}`)
	}
	const proposal = buildProposal(offline, { ...proposalParamsFor(schedule.holderSs58), plan })
	await quoteLeg(
		`#${schedule.ref} sweep`,
		proposal.periodic.instructions,
		SWEEP_FEE_BUDGET_PLANCK,
		plan.scheduled,
	)
	const taskId = schedulerTaskId(`${SCHEDULER_TASK_LABEL}:${schedule.ref}`)
	scheduleCalls.push(
		offline.assetHub.tx.Scheduler.schedule_named_after({
			id: taskId,
			after: proposal.periodic.every,
			maybe_periodic: plan.scheduled > 1 ? [proposal.periodic.every, plan.scheduled] : undefined,
			priority: 0,
			call: proposal.periodic.send.decodedCall,
		}).decodedCall,
	)
	const when = whenFor(schedule)
	cancelCalls.push(
		offline.assetHub.tx.Scheduler.cancel({ when, index: schedule.index }).decodedCall,
	)
	if (!schedule.hasSovereignProxy) holdersNeedingProxy.push(schedule.holderSs58)
	console.log(
		`  #${schedule.ref} ${schedule.mode}: move ${Number(usdt) / 1e6}+${Number(usdc) / 1e6} in ${plan.needed} exec(s); cancel (when ${when}, idx ${schedule.index})${schedule.hasSovereignProxy ? "" : "; +add-proxy"}; task ${taskId.slice(0, 10)}`,
	)
	summaryTasks.push({
		ref: schedule.ref,
		mode: schedule.mode,
		holder: schedule.holderHex,
		oldPreimagePrefix: schedule.hash.slice(0, 8),
		newTaskId: taskId,
		addProxy: !schedule.hasSovereignProxy,
		cancel: { when, index: schedule.index, slot: schedule.slot, period: schedule.period },
		plan: { intervalBlocks: plan.intervalBlocks, needed: plan.needed, scheduled: plan.scheduled },
		amounts: { usdt: usdt.toString(), usdc: usdc.toString() },
	})
}

const addProxySends: Any[] =
	holdersNeedingProxy.length > 0 ? [(await addProxySendFor(holdersNeedingProxy)).decodedCall] : []
const batch = offline.assetHub.tx.Utility.batch_all({
	calls: [...addProxySends, ...cancelCalls, ...scheduleCalls],
})
console.log(
	`\nbatch_all: ${addProxySends.length} add-proxy (${holdersNeedingProxy.length} holders) + ${cancelCalls.length} cancel + ${scheduleCalls.length} schedule = ${batch.encodedData.length} bytes, hash 0x${toHex(Blake2256(batch.encodedData)).slice(2)}`,
)
console.log("\nHydration XCM fees (XcmPaymentApi quote at build time; unspent budget is refunded):")
let totalQuotedPlanck = 0n
let totalBudgetPlanck = 0n
for (const quote of feeQuotes) {
	const ratio = Number(quote.budgetPlanck) / Number(quote.quotedPlanck)
	console.log(
		`  ${quote.leg}: quoted ${formatDot(quote.quotedPlanck)}, budget ${formatDot(quote.budgetPlanck)} (${ratio.toFixed(0)}x), executions ${quote.executions}`,
	)
	totalQuotedPlanck += quote.quotedPlanck * BigInt(quote.executions)
	totalBudgetPlanck += quote.budgetPlanck * BigInt(quote.executions)
}
console.log(
	`  total over all executions: quoted ${formatDot(totalQuotedPlanck)}; the sovereign account needs ${formatDot(ADD_PROXY_FEE_BUDGET_PLANCK > SWEEP_FEE_BUDGET_PLANCK ? ADD_PROXY_FEE_BUDGET_PLANCK : SWEEP_FEE_BUDGET_PLANCK)} liquid per execution and pays about ${formatDot(totalQuotedPlanck)} in total (budget sum ${formatDot(totalBudgetPlanck)})`,
)
const referendumCalls = buildReferendumCalls(
	{ assetHub: offline.assetHub, collectives: offline.collectives },
	batch,
	track,
	enactment,
)
writeFileSync(
	"out/all-preimage.call",
	toHex(referendumCalls.preimageForPublicReferendum.encodedData),
)
writeFileSync("out/all-submit.call", toHex(referendumCalls.publicReferendumSubmission.encodedData))
writeFileSync(
	"out/summary-all.json",
	JSON.stringify(
		{
			track: referendumCalls.track,
			sovereignAccountOnHydration: sovereign.ss58,
			beneficiary: toSs58(beneficiaryKey, POLKADOT_SS58_PREFIX),
			delegateToAdd: AH_SOVEREIGN_PUBKEY_HEX,
			enactAtBlock: cancelAtBlock ?? null,
			tasks: summaryTasks,
			fees: {
				legs: feeQuotes.map((quote) => ({
					leg: quote.leg,
					quotedPlanck: quote.quotedPlanck.toString(),
					budgetPlanck: quote.budgetPlanck.toString(),
					executions: quote.executions,
				})),
				totalQuotedPlanck: totalQuotedPlanck.toString(),
			},
		},
		null,
		2,
	),
)
console.log(`\ntrack: ${referendumCalls.track}`)
console.log(
	`wrote out/all-preimage.call (${referendumCalls.preimageForPublicReferendum.length}B, hash ${referendumCalls.preimageForPublicReferendum.hash})`,
)
console.log(`wrote out/all-submit.call (${referendumCalls.publicReferendumSubmission.length}B)`)
if (
	referendumCalls.track === "whitelisted-caller" &&
	referendumCalls.fellowshipReferendumSubmission
) {
	writeFileSync(
		"out/all-fellowship-submit.call",
		toHex(referendumCalls.fellowshipReferendumSubmission.encodedData),
	)
	console.log(
		`wrote out/all-fellowship-submit.call (${referendumCalls.fellowshipReferendumSubmission.length}B)`,
	)
	if (referendumCalls.preimageForWhitelistCall) {
		writeFileSync(
			"out/all-fellowship-preimage.call",
			toHex(referendumCalls.preimageForWhitelistCall.encodedData),
		)
		console.log(
			`wrote out/all-fellowship-preimage.call (${referendumCalls.preimageForWhitelistCall.length}B)`,
		)
	}
}
console.log("wrote out/summary-all.json")

if (cancelAtBlock !== undefined) {
	const metadataHex = await assetHub.client._request<string, []>("state_getMetadata", [])
	const agenda = getDynamicBuilder(
		getLookupFn(unifyMetadata(decAnyMetadata(fromHex(metadataHex)))),
	).buildStorage("Scheduler", "Agenda")
	const itemsByWhen = new Map<number, Any[]>()
	const slotsToClear = new Set<number>()
	for (const schedule of schedules) {
		const rawAgenda = await assetHub.client._request<string, [string]>("state_getStorage", [
			agenda.keys.enc(schedule.slot),
		])
		const agendaItems = agenda.value.dec(rawAgenda) as Any[]
		const when = whenFor(schedule)
		slotsToClear.add(schedule.slot)
		slotsToClear.add(schedule.slot + schedule.period)
		const relocated = itemsByWhen.get(when) ?? []
		relocated[schedule.index] = agendaItems[schedule.index]
		itemsByWhen.set(when, relocated)
	}
	const lines = ["import-storage:", "  Scheduler:", "    Agenda:"]
	for (const [when, relocated] of itemsByWhen) {
		const itemsWithNulls = Array.from(relocated, (item) => item ?? null)
		lines.push(`      - - [${when}]`, `        - '${toHex(agenda.value.enc(itemsWithNulls))}'`)
	}
	for (const slot of slotsToClear)
		if (!itemsByWhen.has(slot)) lines.push(`      - - [${slot}]`, "        - null")
	const assetHubEndpoint = process.env.AH_ENDPOINT ?? DEFAULT_ENDPOINTS.assetHub[0]
	writeFileSync("out/all-ah-sim.yml", [`endpoint: '${assetHubEndpoint}'`, ...lines, ""].join("\n"))
	console.log(
		`wrote out/all-ah-sim.yml (relocated ${schedules.length} tasks; endpoint ${assetHubEndpoint})`,
	)
}

const reduceChunkedArg = argValue("--reduce-chunked")
if (reduceChunkedArg) {
	const amount = Number(reduceChunkedArg)
	if (!Number.isFinite(amount) || amount <= 0)
		throw new Error("--reduce-chunked must be a positive 6-dp token amount")
	const reduceChunkedTo = BigInt(Math.round(amount * 1e6))
	const chunkedSchedule = schedules.find((schedule) => schedule.mode === "chunked")
	if (!chunkedSchedule) throw new Error("--reduce-chunked: no chunked schedule among the four")
	const hydrationEndpoint = process.env.HYD_ENDPOINT ?? DEFAULT_ENDPOINTS.hydration[0]
	const tokenEntry = (assetId: number) =>
		`      - - ['${chunkedSchedule.holderSs58}', ${assetId}]\n        - free: '${reduceChunkedTo}'\n          reserved: '0'\n          frozen: '0'`
	writeFileSync(
		"out/hyd-reduce.yml",
		[
			`endpoint: '${hydrationEndpoint}'`,
			"import-storage:",
			"  Tokens:",
			"    Accounts:",
			tokenEntry(USDT_HYDRATION),
			tokenEntry(USDC_HYDRATION),
			"",
		].join("\n"),
	)
	console.log(
		`wrote out/hyd-reduce.yml (chunked holder ${chunkedSchedule.holderHex.slice(0, 8)} -> ${Number(reduceChunkedTo) / 1e6} USDT+USDC)`,
	)
}

relayClient.destroy()
hydration.client.destroy()
assetHub.client.destroy()
process.exit(0)
