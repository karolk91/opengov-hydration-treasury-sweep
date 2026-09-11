import type { SS58String } from "polkadot-api"
import { jsonSerialize, toHex } from "polkadot-api/utils"
import { bytesEqual, parseAccount, siblingSovereignAccount, toSs58 } from "./accounts.ts"
import {
	getAssetBalance,
	getAssetMetadata,
	getTreasuryAccount,
	hasDotPool,
	measureSchedulerBlockTimeMs,
	supportedXcmVersionFor,
} from "./assetHub.ts"
import {
	type AssetHubApi,
	connectAssetHub,
	connectHydration,
	getOfflineApis,
	type HydrationApi,
	type OfflineApis,
} from "./chains.ts"
import { HELP, type Options, parseOptions } from "./cli.ts"
import {
	ASSET_HUB_PARA_ID,
	DEFAULTS,
	DOT_DECIMALS,
	EXPECTED_ASSET_HUB_TREASURY,
	HDX_DECIMALS,
	HYDRATION_PARA_ID,
	HYDRATION_SS58_PREFIX,
	POLKADOT_SS58_PREFIX,
	SCHEDULER_TASK_LABEL,
	STABLECOINS,
	type Stablecoin,
} from "./config.ts"
import { describeFootprint, quoteSweepEconomics } from "./footprint.ts"
import { formatUnits, heading, parseUnits } from "./format.ts"
import {
	type CircuitBreakerState,
	getAllTokenHoldings,
	getAssetInfo,
	getNativeBalance,
	getProxyDelegates,
	getTokenBalance,
	type OrmlAccountData,
	resolveAssetIdByLocation,
	withdrawable,
} from "./hydration.ts"
import {
	printCall,
	printReferendumCalls,
	writeCallFile,
	writeCallFiles,
	writeJson,
} from "./output.ts"
import {
	type AssetAmount,
	type ChunkPlan,
	chunkForFootprint,
	neededDurationBlocks,
	planChunks,
	totalDurationBlocks,
} from "./plan.ts"
import { buildProposal, type Proposal, type SweepParams, type XcmLeg } from "./proposal.ts"
import { buildReferendumCalls, describeCall } from "./referendum.ts"
import { verifyProposal } from "./verify.ts"
import { assetHubAssetLocation, DOT_LOCATION, versionedXcm } from "./xcm.ts"

interface ResolvedStablecoin extends Stablecoin {
	readonly hydrationAssetId: number
	readonly balance: OrmlAccountData
}

interface Account {
	readonly ss58: SS58String
	readonly publicKey: Uint8Array
}

const json = (value: unknown): string => JSON.stringify(value, jsonSerialize, 2)

function fmtOrml(data: OrmlAccountData, decimals: number, symbol: string): string {
	const parts = [`free ${formatUnits(data.free, decimals, symbol)}`]
	if (data.reserved > 0n) parts.push(`reserved ${formatUnits(data.reserved, decimals, symbol)}`)
	if (data.frozen > 0n) parts.push(`frozen ${formatUnits(data.frozen, decimals, symbol)}`)
	return parts.join(", ")
}

async function resolveStablecoins(
	hydrationApi: HydrationApi,
	holder: SS58String,
): Promise<ResolvedStablecoin[]> {
	return Promise.all(
		STABLECOINS.map(async (coin) => {
			const location = assetHubAssetLocation(coin.assetHubAssetId, "sibling")
			const hydrationAssetId = await resolveAssetIdByLocation(hydrationApi, location)
			if (hydrationAssetId === undefined) {
				throw new Error(
					`Hydration's asset registry has no asset for Asset Hub asset ${coin.assetHubAssetId} (${coin.symbol})`,
				)
			}
			const info = await getAssetInfo(hydrationApi, hydrationAssetId)
			if (info?.decimals !== undefined && info.decimals !== coin.decimals) {
				throw new Error(
					`${coin.symbol} has ${info.decimals} decimals on Hydration, expected ${coin.decimals}`,
				)
			}
			if (hydrationAssetId !== coin.expectedHydrationAssetId) {
				console.warn(
					`warning: ${coin.symbol} resolved to Hydration asset ${hydrationAssetId}, expected ${coin.expectedHydrationAssetId}`,
				)
			}
			const balance = await getTokenBalance(hydrationApi, holder, hydrationAssetId)
			return { ...coin, hydrationAssetId, balance }
		}),
	)
}

async function printHoldings(
	hydrationApi: HydrationApi,
	title: string,
	account: SS58String,
	highlight: ReadonlySet<number>,
): Promise<void> {
	console.log(heading(title))
	console.log(`  ${account}`)
	const native = await getNativeBalance(hydrationApi, account)
	console.log(`  HDX (native): ${fmtOrml(native, HDX_DECIMALS, "HDX")}`)
	const holdings = await getAllTokenHoldings(hydrationApi, account)
	if (holdings.length === 0) console.log("  (no orml_tokens balances)")
	for (const holding of holdings) {
		const info = await getAssetInfo(hydrationApi, holding.assetId)
		const symbol = info?.symbol || `asset ${holding.assetId}`
		const decimals = info?.decimals ?? 0
		const marker = highlight.has(holding.assetId) ? "  <-- sweep" : ""
		console.log(
			`  ${symbol} (id ${holding.assetId}): ${fmtOrml(holding.data, decimals, symbol)}${marker}`,
		)
	}
}

async function checkProxy(
	hydrationApi: HydrationApi,
	holder: SS58String,
	sovereign: Account,
): Promise<void> {
	console.log(heading("Proxy check"))
	const delegates = await getProxyDelegates(hydrationApi, holder)
	for (const delegate of delegates) {
		const isSovereign = bytesEqual(parseAccount(delegate.delegate), sovereign.publicKey)
		console.log(
			`  delegate ${toSs58(parseAccount(delegate.delegate), HYDRATION_SS58_PREFIX)} type=${delegate.proxyType} delay=${delegate.delay}${isSovereign ? "  <-- Asset Hub's sovereign account" : ""}`,
		)
	}
	const match = delegates.find((d) => bytesEqual(parseAccount(d.delegate), sovereign.publicKey))
	if (!match) {
		throw new Error(
			"Asset Hub's sovereign account has no proxy delegation from the holder; the Transact would fail with NotProxy",
		)
	}
	if (match.delay !== 0)
		throw new Error(`The proxy has an announcement delay of ${match.delay} blocks`)
	if (match.proxyType !== "Any") {
		console.warn(
			`warning: proxy type is ${match.proxyType}, not Any; make sure it allows XTokens and Currencies calls`,
		)
	}
}

function resolveAmounts(coins: readonly ResolvedStablecoin[], options: Options): AssetAmount[] {
	return coins.map((coin) => {
		const override = coin.symbol === "USDT" ? options.usdtAmount : options.usdcAmount
		const available = withdrawable(coin.balance)
		const amount = override !== undefined ? parseUnits(override, coin.decimals) : available
		if (amount > available) {
			console.warn(
				`warning: requested ${formatUnits(amount, coin.decimals, coin.symbol)} but only ${formatUnits(available, coin.decimals, coin.symbol)} is withdrawable`,
			)
		}
		return {
			symbol: coin.symbol,
			hydrationAssetId: coin.hydrationAssetId,
			assetHubAssetId: coin.assetHubAssetId,
			decimals: coin.decimals,
			amount,
		}
	})
}

async function resolveBeneficiary(assetHubApi: AssetHubApi, options: Options): Promise<Account> {
	const publicKey =
		options.beneficiary !== undefined
			? parseAccount(options.beneficiary)
			: await getTreasuryAccount(assetHubApi)
	if (
		options.beneficiary === undefined &&
		!bytesEqual(publicKey, parseAccount(EXPECTED_ASSET_HUB_TREASURY))
	) {
		console.warn(
			`warning: treasury account derived from Treasury.PalletId differs from the expected ${EXPECTED_ASSET_HUB_TREASURY}`,
		)
	}
	return { publicKey, ss58: toSs58(publicKey, POLKADOT_SS58_PREFIX) }
}

function printCircuitBreaker(
	state: CircuitBreakerState | undefined,
	usdtPerHdx: number | undefined,
): void {
	console.log(heading("Hydration XCM egress circuit breaker"))
	if (!state) {
		console.log("  no global withdraw limit configured")
		return
	}
	const hours = Number(state.windowMs) / 3_600_000
	const usd = (hdx: bigint) =>
		usdtPerHdx === undefined
			? ""
			: ` (~${formatUnits(BigInt(Math.round(Number(hdx) * usdtPerHdx)), 6, "USDT")})`
	console.log(
		`  limit:        ${formatUnits(state.limit, HDX_DECIMALS, "HDX")}${usd(state.limit)} per ${hours}h sliding window`,
	)
	console.log(
		`  used now:     ${formatUnits(state.accumulator, HDX_DECIMALS, "HDX")}${usd(state.accumulator)}`,
	)
	const headroom = state.limit > state.accumulator ? state.limit - state.accumulator : 0n
	console.log(`  headroom now: ${formatUnits(headroom, HDX_DECIMALS, "HDX")}${usd(headroom)}`)
	console.log(
		`  lockdown:     ${state.lockdownUntilMs === undefined ? "none" : `until ${new Date(Number(state.lockdownUntilMs)).toISOString()}`}`,
	)
	console.log(`  enforced:     ${state.ignored ? "NO (IgnoreWithdrawLimit is set)" : "yes"}`)
	if (state.lockdownUntilMs !== undefined && state.lockdownUntilMs > state.nowMs) {
		console.warn("  warning: a lockdown is active; XCM withdrawals currently fail")
	}
}

function printPlan(plan: ChunkPlan, blockTimeMs: number): void {
	console.log(heading("Sweep plan"))
	const describe = (amounts: readonly bigint[]) =>
		plan.assets
			.map((asset, i) => formatUnits(amounts[i] ?? 0n, asset.decimals, asset.symbol))
			.join(" + ")
	const hours = (blocks: number) => ((blocks * blockTimeMs) / 3_600_000).toFixed(1)
	console.log(
		`  every ${plan.intervalBlocks} relay-chain blocks (~${hours(plan.intervalBlocks)}h; the Asset Hub scheduler counts relay blocks), starting one interval after enactment:`,
	)
	console.log(`    ${plan.needed} x ${describe(plan.perExecution)} move everything`)
	console.log(
		`    + ${plan.extra} extra executions of the same size as a margin (they fail harmlessly once the holder is empty)`,
	)
	console.log(
		`  ${plan.scheduled} executions scheduled; the needed ones finish ~${hours(neededDurationBlocks(plan))}h after enactment, the margin ~${hours(totalDurationBlocks(plan))}h`,
	)
	const dust = plan.assets
		.map((asset, i) => formatUnits(plan.dust[i] ?? 0n, asset.decimals, asset.symbol))
		.join(" + ")
	console.log(`  rounding dust left on the holder: ${dust}`)
}

function printLeg(leg: XcmLeg, lengthLimit: number): void {
	console.log(`\n${leg.title}:`)
	console.log(`  Hydration call: ${toHex(leg.hydrationCall.encodedData)}`)
	console.log(`  ${json(leg.hydrationCall.decodedCall).replaceAll("\n", "\n  ")}`)
	console.log(`  XCM program: ${json(leg.instructions).replaceAll("\n", "\n  ")}`)
	const send = describeCall("ahp", `${leg.title}: PolkadotXcm.send`, leg.send)
	if (send.length <= lengthLimit)
		console.log(`  PolkadotXcm.send call data: ${toHex(send.encodedData)}`)
	console.log(`  PolkadotXcm.send hash: ${send.hash} (${send.length} bytes)`)
}

async function main(argv: readonly string[]): Promise<void> {
	const options = parseOptions(argv)
	if (options === "help") {
		console.log(HELP)
		return
	}

	const sovereignKey = siblingSovereignAccount(ASSET_HUB_PARA_ID)
	const sovereign: Account = {
		ss58: toSs58(sovereignKey, HYDRATION_SS58_PREFIX),
		publicKey: sovereignKey,
	}
	const holderKey = parseAccount(options.holder)
	const holder = toSs58(holderKey, HYDRATION_SS58_PREFIX)
	const hydrationSovereignOnAssetHub = toSs58(
		siblingSovereignAccount(HYDRATION_PARA_ID),
		POLKADOT_SS58_PREFIX,
	)

	console.log(heading("Accounts"))
	console.log(`  holder (pure proxy) on Hydration:          ${holder}`)
	console.log(`  Asset Hub's sovereign account on Hydration: ${sovereign.ss58}`)
	console.log(`                                              ${toHex(sovereignKey)}`)
	console.log(`  Hydration's sovereign account on Asset Hub: ${hydrationSovereignOnAssetHub}`)

	const hydration = connectHydration(options.hydrationEndpoints)
	const assetHub = connectAssetHub(options.assetHubEndpoints)
	try {
		const [hydrationBlock, assetHubBlock] = await Promise.all([
			hydration.client.getFinalizedBlock(),
			assetHub.client.getFinalizedBlock(),
		])
		console.log(`  Hydration finalized block: #${hydrationBlock.number} (${hydrationBlock.hash})`)
		console.log(`  Asset Hub finalized block: #${assetHubBlock.number} (${assetHubBlock.hash})`)

		// --- Hydration side -------------------------------------------------------------------
		const coins = await resolveStablecoins(hydration.api, holder)
		const dotAssetId = await resolveAssetIdByLocation(hydration.api, DOT_LOCATION)
		if (dotAssetId === undefined) throw new Error("Hydration's asset registry does not know DOT")
		const sweepIds = new Set(coins.map((coin) => coin.hydrationAssetId))
		await printHoldings(
			hydration.api,
			"Holdings of the holder (pure proxy) on Hydration",
			holder,
			sweepIds,
		)
		await printHoldings(
			hydration.api,
			"Holdings of Asset Hub's sovereign account on Hydration",
			sovereign.ss58,
			new Set(),
		)
		await checkProxy(hydration.api, holder, sovereign)

		console.log(heading("Amounts to sweep"))
		const assets = resolveAmounts(coins, options)
		for (const asset of assets)
			console.log(`  ${asset.symbol}: ${formatUnits(asset.amount, asset.decimals)}`)
		const usdtAsset = assets.find((asset) => asset.symbol === "USDT") ?? assets[0]
		if (!usdtAsset) throw new Error("no assets configured")

		// --- Asset Hub side ----------------------------------------------------------------------
		const beneficiary = await resolveBeneficiary(assetHub.api, options)
		const blockTimeMs = await measureSchedulerBlockTimeMs(assetHub.client, assetHub.api)
		// Rounded so that re-running the tool yields the same schedule (and hashes) despite jitter in
		// the measured block time.
		const intervalBlocks = Math.max(
			100,
			Math.round((options.intervalHours * 3_600_000) / blockTimeMs / 100) * 100,
		)
		console.log(heading("Asset Hub context"))
		console.log(`  beneficiary:      ${beneficiary.ss58}`)
		console.log(
			`  scheduler clock:  relay-chain blocks of ~${(blockTimeMs / 1000).toFixed(1)}s -> ${intervalBlocks} blocks (rounded to 100) per ${options.intervalHours}h interval`,
		)
		const version = await supportedXcmVersionFor(assetHub.api, HYDRATION_PARA_ID)
		console.log(
			`  XCM version negotiated with Hydration: ${version ?? "unknown (SafeXcmVersion will be used)"}`,
		)
		for (const asset of assets) {
			const id = Number(asset.assetHubAssetId)
			const metadata = await getAssetMetadata(assetHub.api, id)
			if (metadata.decimals !== asset.decimals) {
				throw new Error(
					`${metadata.symbol} has ${metadata.decimals} decimals on Asset Hub, expected ${asset.decimals}`,
				)
			}
			const [beneficiaryBalance, reserveBalance, pool] = await Promise.all([
				getAssetBalance(assetHub.api, id, beneficiary.ss58),
				getAssetBalance(assetHub.api, id, hydrationSovereignOnAssetHub),
				hasDotPool(assetHub.api, assetHubAssetLocation(asset.assetHubAssetId, "asset-hub")),
			])
			console.log(
				`  ${metadata.symbol} (#${id}): beneficiary holds ${formatUnits(beneficiaryBalance, asset.decimals)}, Hydration's sovereign holds ${formatUnits(reserveBalance, asset.decimals)}, DOT pool for fees: ${pool ? "yes" : "NO"}`,
			)
			if (reserveBalance < asset.amount) {
				throw new Error(
					`Hydration's sovereign account on Asset Hub holds less ${asset.symbol} than the total to sweep; the reserve withdrawals would fail`,
				)
			}
		}

		// --- Chunking and fees ---------------------------------------------------------------
		const feeBudget = parseUnits(options.feeBudgetDot, DOT_DECIMALS)
		const topUpAmount = parseUnits(options.topUpDot, DOT_DECIMALS)
		const offline: OfflineApis = await getOfflineApis()
		const baseParams: Omit<SweepParams, "plan"> = {
			holder,
			sovereign,
			beneficiary: beneficiary.publicKey,
			feeBudget,
			topUp: topUpAmount > 0n ? { dotAssetId, amount: topUpAmount } : undefined,
			priority: 0,
			fallbackMaxWeight: undefined,
		}
		// Weigh one sweep message (its weight does not depend on the amounts) to price the fees, to
		// convert the HDX-denominated limit into the stablecoins' units and to set the v4 fallback.
		const draftChunk = parseUnits(options.chunk ?? DEFAULTS.chunkFallback, usdtAsset.decimals)
		const draft = buildProposal(offline, {
			...baseParams,
			plan: planChunks(assets, draftChunk, intervalBlocks, options.extraExecutions),
		})
		const econ = await quoteSweepEconomics(
			hydration.api,
			versionedXcm(draft.periodic.instructions),
			usdtAsset.assetHubAssetId,
		)
		const feeDot = econ.fees.get("DOT")
		const { usdtPerHdx, limitUnits, windowMs } = econ
		printCircuitBreaker(econ.breaker, usdtPerHdx)

		const intervalMs = intervalBlocks * blockTimeMs
		let chunk: bigint
		if (options.chunk !== undefined) {
			chunk = parseUnits(options.chunk, usdtAsset.decimals)
			console.log(`  chunk: ${formatUnits(chunk, usdtAsset.decimals)} per asset (from --chunk)`)
		} else if (limitUnits !== undefined && windowMs !== undefined) {
			chunk = chunkForFootprint(assets, {
				limitUnits,
				share: options.maxFootprint,
				intervalMs,
				windowMs,
			})
			console.log(
				`  chunk: ${formatUnits(chunk, usdtAsset.decimals)} per asset, derived so that our load peaks at <= ${(options.maxFootprint * 100).toFixed(0)}% of today's limit`,
			)
		} else {
			chunk = parseUnits(DEFAULTS.chunkFallback, usdtAsset.decimals)
			console.warn(
				`  warning: circuit-breaker limit or price unavailable; using the fallback chunk of ${DEFAULTS.chunkFallback}`,
			)
		}
		const plan = planChunks(assets, chunk, intervalBlocks, options.extraExecutions)
		const params: SweepParams = { ...baseParams, plan }
		if (limitUnits !== undefined && windowMs !== undefined) {
			for (const line of describeFootprint(
				plan,
				limitUnits,
				windowMs,
				intervalMs,
				options.maxFootprint,
			)) {
				console.log(`  ${line}`)
			}
		}

		console.log(heading("Fees on Hydration"))
		console.log(
			`  weight of one execution: ref_time ${econ.weight.ref_time}, proof_size ${econ.weight.proof_size}`,
		)
		console.log(
			`  estimated fee:           ${feeDot === undefined ? "unknown" : formatUnits(feeDot, DOT_DECIMALS, "DOT")} per execution`,
		)
		console.log(
			`  fee budget per message:  ${formatUnits(feeBudget, DOT_DECIMALS, "DOT")} (unspent part is refunded to the sovereign account)`,
		)
		const liveSovereignDot = withdrawable(
			await getTokenBalance(hydration.api, sovereign.ss58, dotAssetId),
		)
		// `--assume-sovereign-dot` models an off-chain transfer that pre-funds the sovereign before
		// the referendum enacts, so the fee-sufficiency checks below use it instead of the live
		// balance (typically paired with `--top-up-dot 0`).
		const assumedSovereignDot =
			options.assumeSovereignDot !== undefined
				? parseUnits(options.assumeSovereignDot, DOT_DECIMALS)
				: undefined
		const sovereignDot = assumedSovereignDot ?? liveSovereignDot
		const holderDot = withdrawable(await getTokenBalance(hydration.api, holder, dotAssetId))
		if (assumedSovereignDot !== undefined) {
			console.log(
				`  sovereign account has:   ${formatUnits(liveSovereignDot, DOT_DECIMALS, "DOT")} live, assuming ${formatUnits(assumedSovereignDot, DOT_DECIMALS, "DOT")} pre-funded before enactment`,
			)
		} else {
			console.log(`  sovereign account has:   ${formatUnits(sovereignDot, DOT_DECIMALS, "DOT")}`)
		}
		console.log(`  holder has:              ${formatUnits(holderDot, DOT_DECIMALS, "DOT")}`)
		if (feeDot !== undefined && feeBudget < feeDot * 2n) {
			throw new Error(
				`--fee-budget-dot is below twice the estimated fee (${formatUnits(feeDot, DOT_DECIMALS, "DOT")})`,
			)
		}
		if (sovereignDot < feeBudget) {
			throw new Error(
				"The sovereign account cannot pay for even one execution; fund it with DOT on Hydration first",
			)
		}
		if (params.topUp && holderDot < params.topUp.amount + feeBudget) {
			throw new Error(
				`The holder only has ${formatUnits(holderDot, DOT_DECIMALS, "DOT")}, not enough for a ${options.topUpDot} DOT top-up`,
			)
		}
		const executions = BigInt(plan.scheduled + (params.topUp ? 1 : 0))
		const available = sovereignDot + (params.topUp?.amount ?? 0n)
		if (feeDot !== undefined) {
			console.log(
				`  total estimated fees:    ${formatUnits(feeDot * executions, DOT_DECIMALS, "DOT")} for ${executions} executions, ${formatUnits(available, DOT_DECIMALS, "DOT")} available`,
			)
			if (available < feeDot * executions * 2n) {
				console.warn(
					"  warning: less than twice the estimated total fees available; fund the sovereign account (out of band or via --top-up-dot)",
				)
			}
		}
		printPlan(plan, blockTimeMs)
		if (options.balancesOnly) return

		// --- Build the proposal ---------------------------------------------------------------
		const proposal: Proposal = buildProposal(offline, {
			...params,
			fallbackMaxWeight: econ.weight,
		})
		console.log(heading("Proposal legs"))
		if (proposal.topUp) printLeg(proposal.topUp, options.lengthLimit)
		printLeg(proposal.periodic, options.lengthLimit)
		console.log(
			`  scheduled ${proposal.periodic.count} time(s) (${plan.needed} needed + ${plan.extra} margin): first after ${proposal.periodic.firstAfter} blocks, then every ${proposal.periodic.every} blocks`,
		)
		console.log(
			`  scheduler task id: ${proposal.periodic.taskId} (label: "${SCHEDULER_TASK_LABEL}")`,
		)
		const cancel = describeCall(
			"ahp",
			"Stop the sweep early (Scheduler.cancel_named)",
			proposal.cancel,
		)
		console.log(`  to stop early, governance dispatches: ${toHex(cancel.encodedData)}`)

		// Round-trip through the live runtime's metadata to be sure the call decodes there.
		const live = await assetHub.api.txFromCallData(proposal.call.encodedData)
		if (
			JSON.stringify(live.decodedCall, jsonSerialize) !==
			JSON.stringify(proposal.call.decodedCall, jsonSerialize)
		) {
			throw new Error(
				"The proposal decodes differently on the live runtime; update the metadata (npm run papi:update)",
			)
		}
		const proposalInfo = describeCall(
			"ahp",
			"Proposal to enact on Polkadot Asset Hub",
			proposal.call,
		)
		console.log(heading("Proposal"))
		printCall(proposalInfo, { lengthLimit: options.lengthLimit })

		// --- Verify with the runtimes' DryRunApi -----------------------------------------------
		if (!options.skipDryRun) {
			console.log(heading("Dry run"))
			// When the live sovereign can't cover one fee budget, the sweep relies on out-of-band
			// pre-funding that a live dry run can't see — skip just that leg (the proposal dispatch is
			// still dry-run, and the sweep runs for real in the e2e fork).
			const skipSweepDryRun = liveSovereignDot < feeBudget
			const report = await verifyProposal(
				assetHub.api,
				hydration.api,
				proposal,
				beneficiary.ss58,
				assets,
				skipSweepDryRun,
			)
			for (const check of report.checks) {
				console.log(`  [${check.skipped ? "SKIP" : check.ok ? "PASS" : "FAIL"}] ${check.title}`)
				for (const detail of check.details) console.log(`         ${detail}`)
			}
			if (!report.ok) throw new Error("dry run failed; not generating referendum calls")
		}

		// --- Referendum calls ----------------------------------------------------------------
		console.log(heading(`Referendum calls (${options.track} track)`))
		const calls = buildReferendumCalls(
			{ assetHub: offline.assetHub, collectives: offline.collectives },
			proposal.call,
			options.track,
			options.enactment,
		)
		printReferendumCalls(calls, { lengthLimit: options.lengthLimit })

		const files = writeCallFiles(options.outDir, calls)
		files.push(writeCallFile(options.outDir, cancel))
		const legSummary = (leg: XcmLeg) => ({
			hydrationCall: toHex(leg.hydrationCall.encodedData),
			hydrationCallDecoded: leg.hydrationCall.decodedCall,
			xcm: leg.instructions,
			send: toHex(leg.send.encodedData),
		})
		files.push(
			writeJson(options.outDir, "summary.json", {
				generatedAt: new Date().toISOString(),
				track: options.track,
				enactment: options.enactment,
				hydrationBlock,
				assetHubBlock,
				holder,
				sovereignAccountOnHydration: sovereign.ss58,
				beneficiary: beneficiary.ss58,
				amounts: assets.map((asset) => ({
					symbol: asset.symbol,
					hydrationAssetId: asset.hydrationAssetId,
					assetHubAssetId: asset.assetHubAssetId,
					amount: asset.amount,
					formatted: formatUnits(asset.amount, asset.decimals),
				})),
				footprint: { maxShare: options.maxFootprint, limitUnits, chunk },
				plan: {
					intervalBlocks: plan.intervalBlocks,
					schedulerBlockTimeMs: blockTimeMs,
					perExecution: plan.perExecution,
					needed: plan.needed,
					extra: plan.extra,
					scheduled: plan.scheduled,
					dust: plan.dust,
				},
				fees: {
					budgetPerExecution: feeBudget,
					estimatedPerExecution: feeDot,
					topUp: params.topUp?.amount,
				},
				circuitBreaker: econ.breaker,
				legs: {
					topUp: proposal.topUp ? legSummary(proposal.topUp) : undefined,
					periodic: legSummary(proposal.periodic),
				},
				schedulerTask: {
					id: proposal.periodic.taskId,
					label: SCHEDULER_TASK_LABEL,
					cancel: toHex(cancel.encodedData),
				},
				proposal: {
					hash: proposalInfo.hash,
					length: proposalInfo.length,
					data: toHex(proposalInfo.encodedData),
				},
				publicReferendum: {
					preimageHash: calls.preimageForPublicReferendum.hash,
					submission: toHex(calls.publicReferendumSubmission.encodedData),
				},
				fellowshipReferendum: calls.fellowshipReferendumSubmission
					? toHex(calls.fellowshipReferendumSubmission.encodedData)
					: undefined,
			}),
		)
		console.log(heading("Files written"))
		for (const file of files) console.log(`  ${file}`)
	} finally {
		hydration.client.destroy()
		assetHub.client.destroy()
	}
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(`\nerror: ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
})
