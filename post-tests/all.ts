import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { AccountId } from "@polkadot-api/substrate-bindings"
import { HYDRATION_SS58_PREFIX } from "../src/config.ts"
import { hexToBytes, hexWithoutPrefix } from "../src/hex.ts"
import { isRecord } from "../src/verify.ts"
import {
	type Any,
	advanceTime,
	build,
	connect,
	field,
	fireScheduledTask,
	type PostTestContext,
	setBlockDetails,
} from "./chopsticks.ts"

const USDT_ASSET_HUB = 1984
const USDC_ASSET_HUB = 1337
const USDT_HYDRATION = 10
const USDC_HYDRATION = 22

interface HolderBalances {
	usdt: bigint
	usdc: bigint
}
interface Snapshot {
	treasuryUsdt: bigint
	treasuryUsdc: bigint
	holders: Record<string, HolderBalances>
}

const pubkeyToHydration = (pubkeyHex: string) =>
	AccountId(HYDRATION_SS58_PREFIX).dec(hexToBytes(pubkeyHex))
const holderBalancesOf = (snapshot: Snapshot, ref: string): HolderBalances => {
	const balances = snapshot.holders[ref]
	if (!balances) throw new Error(`no balances recorded for #${ref}`)
	return balances
}

export default async function all(ctx: PostTestContext): Promise<void> {
	const outDir =
		(isRecord(ctx.args) && typeof ctx.args.outDir === "string" && ctx.args.outDir) || "out"
	if (isRecord(ctx.args) && Number(ctx.args.blockDetails) === 0) setBlockDetails(false)
	const summary = JSON.parse(readFileSync(join(outDir, "summary-all.json"), "utf-8"))
	const beneficiary: string = summary.beneficiary
	const delegatePubkey = String(summary.delegateToAdd).toLowerCase()
	const tasks: Any[] = summary.tasks
	const firstTask = tasks[0]
	if (!firstTask) throw new Error("summary-all.json lists no tasks")

	const find = (needle: string) =>
		ctx.chains.find(
			(chain) => chain.specName?.includes(needle) || chain.label.toLowerCase().includes(needle),
		)
	const assetHub = await connect(find("asset-hub") ?? find("statemint") ?? ctx.main)
	const hydrationMeta = find("hydr")
	const relayMeta =
		ctx.chains.find((chain) => chain.kind === "relay") ??
		ctx.chains.find((chain) => chain.specName === "polkadot")
	assert.ok(hydrationMeta && relayMeta, "need Hydration + relay among --additional-chains")
	const hydration = await connect(hydrationMeta)
	const relay = await connect(relayMeta)
	try {
		const delegatesOf = async (holderPubkeyHex: string): Promise<string[]> => {
			const proxies = (await hydration.api.query.Proxy.Proxies.getValue(
				pubkeyToHydration(holderPubkeyHex),
			)) as unknown
			const definitions = Array.isArray(proxies) ? (proxies[0] as Any[]) : []
			return (definitions ?? []).map((definition: Any) =>
				hexWithoutPrefix(
					typeof definition.delegate === "string"
						? AccountId(HYDRATION_SS58_PREFIX).enc(definition.delegate)
						: definition.delegate,
				),
			)
		}

		const tasksNeedingProxy = tasks.filter((task) => task.addProxy)
		console.log(`\n[all] driving ${tasksNeedingProxy.length} add-proxy XCM(s) to Hydration`)
		const pending = new Set<string>(tasksNeedingProxy.map((task) => task.holder))
		for (let round = 0; round < 16 && pending.size > 0; round++) {
			await build(relay)
			await build(hydration)
			for (const task of tasksNeedingProxy) {
				if (pending.has(task.holder) && (await delegatesOf(task.holder)).includes(delegatePubkey))
					pending.delete(task.holder)
			}
		}
		for (const task of tasksNeedingProxy) {
			const delegates = await delegatesOf(task.holder)
			console.log(
				`  #${task.ref} ${task.holder.slice(0, 8)} delegates: [${delegates.map((delegate) => delegate.slice(0, 8)).join(", ")}]`,
			)
			assert.ok(
				delegates.includes(delegatePubkey),
				`#${task.ref}: AH-sov delegate not added to ${task.holder.slice(0, 8)}`,
			)
		}

		console.log("\n[all] checking the Asset Hub scheduler")
		const entries = await assetHub.api.query.Scheduler.Agenda.getEntries()
		const legacyHashPrefixes = new Set<string>()
		const taskIds = new Set<string>()
		for (const entry of entries)
			for (const item of (entry.value ?? []) as Any[]) {
				if (item?.call?.type === "Lookup")
					legacyHashPrefixes.add(hexWithoutPrefix(item.call.value.hash).slice(0, 8))
				const id = hexWithoutPrefix(field(item, "maybe_id", "maybeId"))
				if (id) taskIds.add(id)
			}
		for (const task of tasks) {
			const legacyTaskAbsent = !legacyHashPrefixes.has(String(task.oldPreimagePrefix))
			const newTaskPresent = taskIds.has(String(task.newTaskId).replace(/^0x/, ""))
			console.log(
				`  #${task.ref}: old ${task.oldPreimagePrefix} absent=${legacyTaskAbsent}, new ${String(task.newTaskId).slice(0, 10)} present=${newTaskPresent}`,
			)
			assert.ok(
				legacyTaskAbsent,
				`#${task.ref}: legacy schedule (${task.oldPreimagePrefix}) was not cancelled`,
			)
			assert.ok(newTaskPresent, `#${task.ref}: new sweep task was not scheduled`)
		}

		console.log("\n[all] driving the new sweeps, checking drains + treasury")
		const treasuryBalance = (assetId: number): Promise<bigint> =>
			assetHub.api.query.Assets.Account.getValue(assetId, beneficiary).then(
				(account: Any) => account?.balance ?? 0n,
			)
		const holderBalance = (holderPubkeyHex: string, assetId: number): Promise<bigint> =>
			hydration.api.query.Tokens.Accounts.getValue(
				pubkeyToHydration(holderPubkeyHex),
				assetId,
			).then((account: Any) => account?.free ?? 0n)
		const interval = Number(firstTask.plan.intervalBlocks) || 600
		const executionsArg = isRecord(ctx.args) ? String(ctx.args.executions ?? "once") : "once"
		const driveFullDrain = executionsArg === "all"
		const parsedExecCount = Number(executionsArg)
		const execCount = Number.isInteger(parsedExecCount) && parsedExecCount > 0 ? parsedExecCount : 1
		const snapshot = async (): Promise<Snapshot> => ({
			treasuryUsdt: await treasuryBalance(USDT_ASSET_HUB),
			treasuryUsdc: await treasuryBalance(USDC_ASSET_HUB),
			holders: Object.fromEntries(
				await Promise.all(
					tasks.map(
						async (task) =>
							[
								task.ref,
								{
									usdt: await holderBalance(task.holder, USDT_HYDRATION),
									usdc: await holderBalance(task.holder, USDC_HYDRATION),
								},
							] as const,
					),
				),
			),
		})
		const advanceAndBuild = async () => {
			await advanceTime(hydration, interval * 6000)
			for (let built = 0; built < 6; built++) {
				await build(hydration)
				await build(assetHub)
			}
		}
		const before = await snapshot()
		for (const task of tasks) {
			try {
				const dispatch = await fireScheduledTask(assetHub, String(task.newTaskId))
				console.log(`  #${task.ref} fired: ${JSON.stringify(dispatch.result)}`)
			} catch (error) {
				if (String((error as Error).message).includes("not found"))
					console.log(`  #${task.ref} already fired (single-shot done)`)
				else throw error
			}
			await advanceAndBuild()
		}
		const chunkedTask = tasks.find((task) => task.mode === "chunked")
		assert.ok(chunkedTask, "no chunked task among the sweeps")
		const chunkUsdt = BigInt(chunkedTask.amounts.usdt) / BigInt(chunkedTask.plan.needed)
		const chunkUsdc = BigInt(chunkedTask.amounts.usdc) / BigInt(chunkedTask.plan.needed)
		const maxChunkedFirings = driveFullDrain ? chunkedTask.plan.needed + 20 : execCount
		for (let firing = 1; firing < maxChunkedFirings; firing++) {
			const holderUsdt = await holderBalance(chunkedTask.holder, USDT_HYDRATION)
			const holderUsdc = await holderBalance(chunkedTask.holder, USDC_HYDRATION)
			if (holderUsdt < chunkUsdt && holderUsdc < chunkUsdc) {
				if (driveFullDrain) console.log(`  #${chunkedTask.ref} holder drained`)
				break
			}
			try {
				const dispatch = await fireScheduledTask(assetHub, String(chunkedTask.newTaskId))
				assert.ok(
					isRecord(dispatch.result) && dispatch.result.success === true,
					`#${chunkedTask.ref} dispatch failed: ${JSON.stringify(dispatch.result)}`,
				)
			} catch (error) {
				if (String((error as Error).message).includes("not found")) break
				throw error
			}
			await advanceAndBuild()
			if (firing <= 2 || firing % 25 === 0)
				console.log(`  #${chunkedTask.ref}: ${firing + 1} executions`)
		}
		const after = await snapshot()
		for (const task of tasks) {
			const startBalances = holderBalancesOf(before, task.ref)
			const endBalances = holderBalancesOf(after, task.ref)
			const usdtDrop = startBalances.usdt - endBalances.usdt
			const usdcDrop = startBalances.usdc - endBalances.usdc
			console.log(
				`  #${task.ref} holder drained ${Number(usdtDrop) / 1e6} USDT + ${Number(usdcDrop) / 1e6} USDC (left ${Number(endBalances.usdt) / 1e6}+${Number(endBalances.usdc) / 1e6})`,
			)
			assert.ok(
				usdtDrop > 0n && usdcDrop > 0n,
				`#${task.ref}: holder did not drain; the proxied transfer failed`,
			)
			const lookup = await assetHub.api.query.Scheduler.Lookup.getValue(String(task.newTaskId))
			if (task.mode === "chunked") {
				if (driveFullDrain)
					assert.ok(
						endBalances.usdt < chunkUsdt && endBalances.usdc < chunkUsdc,
						`#${task.ref}: not fully drained (${Number(endBalances.usdt) / 1e6}+${Number(endBalances.usdc) / 1e6} left)`,
					)
				else assert.ok(lookup, `#${task.ref}: periodic sweep task unexpectedly gone`)
			} else {
				assert.ok(!lookup, `#${task.ref}: single-shot task still scheduled after firing`)
			}
		}
		console.log(
			`  treasury gained ${Number(after.treasuryUsdt - before.treasuryUsdt) / 1e6} USDT + ${Number(after.treasuryUsdc - before.treasuryUsdc) / 1e6} USDC -> ${beneficiary}`,
		)
		assert.ok(
			after.treasuryUsdt > before.treasuryUsdt && after.treasuryUsdc > before.treasuryUsdc,
			"current treasury not credited",
		)
		console.log(
			`\n[all] ${driveFullDrain ? "full sweep: " : ""}3 proxies added, 4 legacy schedules cancelled, sweeps drain their holders and credit the current treasury`,
		)
	} finally {
		assetHub.client.destroy()
		hydration.client.destroy()
		relay.client.destroy()
	}
}
