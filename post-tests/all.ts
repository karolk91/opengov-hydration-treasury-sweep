import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AccountId } from "@polkadot-api/substrate-bindings"
import { createClient, type PolkadotClient } from "polkadot-api"
import { getWsProvider } from "polkadot-api/ws"
import { advanceTime, fireScheduledTask, setBlockDetails } from "./sweep.ts"

// biome-ignore lint/suspicious/noExplicitAny: getUnsafeApi() is untyped.
type Any = any
interface Blockchain {
	newBlock(p?: Record<string, unknown>): Promise<unknown>
	head?: { number: number }
}
interface PostTestChain {
	label: string
	specName: string
	kind?: string
	wsEndpoint: string
	chain: unknown
}
interface PostTestContext {
	main: PostTestChain
	chains: PostTestChain[]
	args: unknown
}
interface Chain {
	client: PolkadotClient
	api: Any
	bc: Blockchain
	label: string
	slotMs: number
}

const OP_TIMEOUT_MS = 300_000
const USDT_AH = 1984
const USDC_AH = 1337
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null
const hx = (v: Any): string =>
	v == null
		? ""
		: typeof v === "string"
			? v.replace(/^0x/, "")
			: typeof v.asHex === "function"
				? v.asHex().replace(/^0x/, "")
				: v instanceof Uint8Array
					? Buffer.from(v).toString("hex")
					: ""
const field = (o: Any, ...names: string[]) => {
	for (const n of names) if (o?.[n] !== undefined) return o[n]
	return undefined
}
const pubToHyd = (pubHex: string) => AccountId(63).dec(Uint8Array.from(Buffer.from(pubHex, "hex")))
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, r) => setTimeout(() => r(new Error(`timeout ${label}`)), ms).unref()),
	])
}
async function connect(meta: PostTestChain): Promise<Chain> {
	const client = createClient(getWsProvider(meta.wsEndpoint))
	const api = client.getUnsafeApi() as Any
	let slotMs = 6000
	try {
		slotMs = Number(await api.constants.Aura.SlotDuration())
	} catch {
		slotMs = 6000
	}
	return { client, api, bc: meta.chain as Blockchain, label: meta.label, slotMs }
}
const build = (c: Chain) => withTimeout(c.bc.newBlock(), OP_TIMEOUT_MS, `newBlock ${c.label}`)

export default async function all(ctx: PostTestContext): Promise<void> {
	const outDir =
		(isRecord(ctx.args) && typeof ctx.args.outDir === "string" && ctx.args.outDir) || "out"
	if (isRecord(ctx.args) && Number(ctx.args.blockDetails) === 0) setBlockDetails(false)
	const s = JSON.parse(readFileSync(join(outDir, "summary-all.json"), "utf-8"))
	const beneficiary: string = s.beneficiary
	const delegate = String(s.delegateToAdd).toLowerCase()
	const tasks: Any[] = s.tasks

	const find = (n: string) =>
		ctx.chains.find((c) => c.specName?.includes(n) || c.label.toLowerCase().includes(n))
	const ah = await connect(find("asset-hub") ?? find("statemint") ?? ctx.main)
	const hydMeta = find("hydr")
	const relayMeta =
		ctx.chains.find((c) => c.kind === "relay") ?? ctx.chains.find((c) => c.specName === "polkadot")
	assert.ok(hydMeta && relayMeta, "need Hydration + relay among --additional-chains")
	const hyd = await connect(hydMeta)
	const relay = await connect(relayMeta)
	try {
		const delegatesOf = async (holderPubHex: string): Promise<string[]> => {
			const res = (await hyd.api.query.Proxy.Proxies.getValue(pubToHyd(holderPubHex))) as unknown
			const list = Array.isArray(res) ? (res[0] as Any[]) : []
			return (list ?? []).map((d: Any) =>
				hx(typeof d.delegate === "string" ? AccountId(63).enc(d.delegate) : d.delegate),
			)
		}

		const needProxy = tasks.filter((t) => t.addProxy)
		console.log(`\n[all] driving ${needProxy.length} add-proxy XCM(s) to Hydration`)
		const pending = new Set(needProxy.map((t) => t.holder))
		for (let round = 0; round < 16 && pending.size > 0; round++) {
			await build(relay)
			await build(hyd)
			for (const t of needProxy) {
				if (pending.has(t.holder) && (await delegatesOf(t.holder)).includes(delegate))
					pending.delete(t.holder)
			}
		}
		for (const t of needProxy) {
			const dels = await delegatesOf(t.holder)
			console.log(
				`  #${t.ref} ${t.holder.slice(0, 8)} delegates: [${dels.map((d) => d.slice(0, 8)).join(", ")}]`,
			)
			assert.ok(
				dels.includes(delegate),
				`#${t.ref}: AH-sov delegate not added to ${t.holder.slice(0, 8)}`,
			)
		}

		console.log("\n[all] checking the Asset Hub scheduler")
		const entries = await ah.api.query.Scheduler.Agenda.getEntries()
		const oldHashes = new Set<string>()
		const newIds = new Set<string>()
		for (const e of entries)
			for (const it of (e.value ?? []) as Any[]) {
				if (it?.call?.type === "Lookup") oldHashes.add(hx(it.call.value.hash).slice(0, 8))
				const id = hx(field(it, "maybe_id", "maybeId"))
				if (id) newIds.add(id)
			}
		for (const t of tasks) {
			const oldGone = !oldHashes.has(String(t.oldPreimagePrefix))
			const newPresent = newIds.has(String(t.newTaskId).replace(/^0x/, ""))
			console.log(
				`  #${t.ref}: old ${t.oldPreimagePrefix} gone=${oldGone}, new ${String(t.newTaskId).slice(0, 10)} present=${newPresent}`,
			)
			assert.ok(oldGone, `#${t.ref}: legacy schedule (${t.oldPreimagePrefix}) was not cancelled`)
			assert.ok(newPresent, `#${t.ref}: new sweep task was not scheduled`)
		}

		console.log("\n[all] driving the new sweeps, checking drains + treasury")
		const treasury = (id: number) =>
			ah.api.query.Assets.Account.getValue(id, beneficiary).then((b: Any) => b?.balance ?? 0n)
		const holderTok = (holderPub: string, id: number) =>
			hyd.api.query.Tokens.Accounts.getValue(pubToHyd(holderPub), id).then(
				(b: Any) => b?.free ?? 0n,
			)
		const interval = Number(tasks[0].plan.intervalBlocks) || 600
		const executionsArg = isRecord(ctx.args) ? String(ctx.args.executions ?? "once") : "once"
		const execAll = executionsArg === "all"
		const parsedExecCount = Number(executionsArg)
		const execCount = Number.isInteger(parsedExecCount) && parsedExecCount > 0 ? parsedExecCount : 1
		const snap = async () => ({
			tU: await treasury(USDT_AH),
			tC: await treasury(USDC_AH),
			h: Object.fromEntries(
				await Promise.all(
					tasks.map(
						async (t) =>
							[t.ref, [await holderTok(t.holder, 10), await holderTok(t.holder, 22)]] as const,
					),
				),
			) as Record<string, [bigint, bigint]>,
		})
		const advanceAndBuild = async () => {
			await advanceTime(hyd, interval * 6000)
			for (let j = 0; j < 6; j++) {
				await build(hyd)
				await build(ah)
			}
		}
		const before = await snap()
		for (const t of tasks) {
			try {
				const d = await fireScheduledTask(ah, String(t.newTaskId))
				console.log(`  #${t.ref} fired: ${JSON.stringify(d.result)}`)
			} catch (e) {
				if (String((e as Error).message).includes("not found"))
					console.log(`  #${t.ref} already fired (single-shot done)`)
				else throw e
			}
			await advanceAndBuild()
		}
		const chunked = tasks.find((t) => t.mode === "chunked")
		assert.ok(chunked, "no chunked task among the sweeps")
		const chunkU = BigInt(chunked.amounts.usdt) / BigInt(chunked.plan.needed)
		const chunkC = BigInt(chunked.amounts.usdc) / BigInt(chunked.plan.needed)
		const maxChunkedFirings = execAll ? chunked.plan.needed + 20 : execCount
		for (let firing = 1; firing < maxChunkedFirings; firing++) {
			const [hu, hc] = [await holderTok(chunked.holder, 10), await holderTok(chunked.holder, 22)]
			if (hu < chunkU && hc < chunkC) {
				if (execAll) console.log(`  #${chunked.ref} holder drained`)
				break
			}
			try {
				const d = await fireScheduledTask(ah, String(chunked.newTaskId))
				assert.ok(
					isRecord(d.result) && d.result.success === true,
					`#${chunked.ref} dispatch failed: ${JSON.stringify(d.result)}`,
				)
			} catch (e) {
				if (String((e as Error).message).includes("not found")) break
				throw e
			}
			await advanceAndBuild()
			if (firing <= 2 || firing % 25 === 0)
				console.log(`  #${chunked.ref}: ${firing + 1} executions`)
		}
		const after = await snap()
		for (const t of tasks) {
			const dU = before.h[t.ref][0] - after.h[t.ref][0]
			const dC = before.h[t.ref][1] - after.h[t.ref][1]
			console.log(
				`  #${t.ref} holder drained ${Number(dU) / 1e6} USDT + ${Number(dC) / 1e6} USDC (left ${Number(after.h[t.ref][0]) / 1e6}+${Number(after.h[t.ref][1]) / 1e6})`,
			)
			assert.ok(dU > 0n && dC > 0n, `#${t.ref}: holder did not drain — the proxied transfer failed`)
			const lookup = await ah.api.query.Scheduler.Lookup.getValue(String(t.newTaskId))
			if (t.mode === "chunked") {
				if (execAll)
					assert.ok(
						after.h[t.ref][0] < chunkU && after.h[t.ref][1] < chunkC,
						`#${t.ref}: not fully drained (${Number(after.h[t.ref][0]) / 1e6}+${Number(after.h[t.ref][1]) / 1e6} left)`,
					)
				else assert.ok(lookup, `#${t.ref}: periodic sweep task unexpectedly gone`)
			} else {
				assert.ok(!lookup, `#${t.ref}: single-shot task still scheduled after firing`)
			}
		}
		console.log(
			`  treasury gained ${Number(after.tU - before.tU) / 1e6} USDT + ${Number(after.tC - before.tC) / 1e6} USDC -> ${beneficiary}`,
		)
		assert.ok(after.tU > before.tU && after.tC > before.tC, "current treasury not credited")

		console.log(
			`\n[all] ${execAll ? "full sweep: " : ""}3 proxies added, 4 legacy schedules cancelled, sweeps drain their holders and credit the current treasury`,
		)
	} finally {
		ah.client.destroy()
		hyd.client.destroy()
		relay.client.destroy()
	}
}
