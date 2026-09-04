import type { XcmVersionedXcm } from "@polkadot-api/descriptors"
import { XcmVersionedLocation } from "@polkadot-api/descriptors"
import type { SS58String } from "polkadot-api"
import { jsonSerialize } from "polkadot-api/utils"
import type { AssetHubApi, HydrationApi } from "./chains.ts"
import { ASSET_HUB_PARA_ID, HYDRATION_PARA_ID } from "./config.ts"
import type { Proposal } from "./proposal.ts"
import { ROOT_ORIGIN } from "./referendum.ts"
import { ASSET_HUB_LOCATION, HYDRATION_LOCATION, versionedXcm } from "./xcm.ts"

type AssetHubRuntimeCall = Parameters<AssetHubApi["apis"]["DryRunApi"]["dry_run_call"]>[1]

/** Shape of every `RuntimeEvent`; we only need the pallet/event names and a loosely typed payload. */
interface AnyEvent {
	readonly type: string
	readonly value: { readonly type: string; readonly value: unknown }
}

export interface CheckResult {
	readonly title: string
	readonly ok: boolean
	/** The check did not run (e.g. it depends on out-of-band state); `ok` is true but unverified. */
	readonly skipped?: boolean
	readonly details: readonly string[]
}

const XCM_VERSION = 5

function eventNames(events: readonly AnyEvent[]): string {
	return events.map((event) => `${event.type}.${event.value.type}`).join(", ")
}

function json(value: unknown): string {
	return JSON.stringify(value, jsonSerialize)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

/** `Proxy.ProxyExecuted { result }`: the inner call's outcome. */
function proxyOutcome(events: readonly AnyEvent[]): { ok: boolean; error?: string } | undefined {
	const event = events.find((e) => e.type === "Proxy" && e.value.type === "ProxyExecuted")
	if (!event || !isRecord(event.value.value) || !isRecord(event.value.value.result))
		return undefined
	const result = event.value.value.result
	return result.success === true ? { ok: true } : { ok: false, error: json(result.value) }
}

function isParachain(location: XcmVersionedLocation, paraId: number): boolean {
	const { parents, interior } = location.value
	return (
		parents === 1 &&
		interior.type === "X1" &&
		interior.value.type === "Parachain" &&
		interior.value.value === paraId
	)
}

/** Root dispatches the proposal on Asset Hub; the top-up XCM (if any) is forwarded to Hydration. */
export async function dryRunProposal(
	assetHub: AssetHubApi,
	proposal: Proposal,
): Promise<{ result: CheckResult; forwardedToHydration: XcmVersionedXcm[] }> {
	const title = "Asset Hub: dispatch the proposal as Root"
	const dry = await assetHub.apis.DryRunApi.dry_run_call(
		ROOT_ORIGIN,
		proposal.call.decodedCall as AssetHubRuntimeCall,
		XCM_VERSION,
	)
	if (!dry.success) {
		return {
			result: { title, ok: false, details: [`DryRunApi error: ${json(dry.value)}`] },
			forwardedToHydration: [],
		}
	}
	const { execution_result, emitted_events, forwarded_xcms } = dry.value
	const events = emitted_events as readonly AnyEvent[]
	const scheduled = events.filter(
		(e) => e.type === "Scheduler" && e.value.type === "Scheduled",
	).length
	const expectedScheduled = 1
	const forwardedToHydration = forwarded_xcms
		.filter(([dest]) => isParachain(dest, HYDRATION_PARA_ID))
		.flatMap(([, xcms]) => xcms)
	const details = [
		`dispatch: ${execution_result.success ? "ok" : `error ${json(execution_result.value.error)}`}`,
		`events: ${eventNames(events)}`,
		`scheduler tasks created: ${scheduled} (expected ${expectedScheduled})`,
		`XCMs forwarded to Hydration now: ${forwardedToHydration.length} (expected ${proposal.topUp ? 1 : 0})`,
	]
	const ok =
		execution_result.success &&
		scheduled === expectedScheduled &&
		forwardedToHydration.length === (proposal.topUp ? 1 : 0)
	return { result: { title, ok, details }, forwardedToHydration }
}

/** Executes one of our XCM programs on Hydration as if it had just arrived from Asset Hub. */
export async function dryRunOnHydration(
	hydration: HydrationApi,
	title: string,
	message: XcmVersionedXcm,
	expect: { forwardedToAssetHub: number },
): Promise<{ result: CheckResult; forwardedToAssetHub: XcmVersionedXcm[] }> {
	const dry = await hydration.apis.DryRunApi.dry_run_xcm(
		XcmVersionedLocation.V5(ASSET_HUB_LOCATION),
		message,
	)
	if (!dry.success) {
		return {
			result: { title, ok: false, details: [`DryRunApi error: ${json(dry.value)}`] },
			forwardedToAssetHub: [],
		}
	}
	const { execution_result, emitted_events, forwarded_xcms } = dry.value
	const events = emitted_events as readonly AnyEvent[]
	const proxy = proxyOutcome(events)
	const forwardedToAssetHub = forwarded_xcms
		.filter(([dest]) => isParachain(dest, ASSET_HUB_PARA_ID))
		.flatMap(([, xcms]) => xcms)
	const details = [
		`xcm outcome: ${execution_result.type}${execution_result.type === "Complete" ? "" : ` ${json(execution_result.value)}`}`,
		`events: ${eventNames(events)}`,
		`proxy call: ${proxy ? (proxy.ok ? "ok" : `failed ${proxy.error}`) : "no ProxyExecuted event"}`,
		`XCMs forwarded to Asset Hub: ${forwardedToAssetHub.length} (expected ${expect.forwardedToAssetHub})`,
	]
	const ok =
		execution_result.type === "Complete" &&
		proxy?.ok === true &&
		forwardedToAssetHub.length === expect.forwardedToAssetHub
	return { result: { title, ok, details }, forwardedToAssetHub }
}

/** Executes the reserve-withdrawal Hydration sends back, checking the beneficiary gets the assets. */
export async function dryRunDepositOnAssetHub(
	assetHub: AssetHubApi,
	message: XcmVersionedXcm,
	beneficiary: SS58String,
	expected: ReadonlyArray<{ readonly assetHubAssetId: bigint; readonly symbol: string }>,
): Promise<CheckResult> {
	const title = "Asset Hub: execute the transfer Hydration sends back"
	const dry = await assetHub.apis.DryRunApi.dry_run_xcm(
		XcmVersionedLocation.V5(HYDRATION_LOCATION),
		message,
	)
	if (!dry.success) return { title, ok: false, details: [`DryRunApi error: ${json(dry.value)}`] }
	const { execution_result, emitted_events } = dry.value
	const events = emitted_events as readonly AnyEvent[]
	// `pallet_assets` credits through `fungibles::Balanced` (event `Deposited { asset_id, who, amount }`);
	// older runtimes used `mint_into` (event `Issued { asset_id, owner, amount }`).
	const credits = events.filter(
		(e) => e.type === "Assets" && (e.value.type === "Deposited" || e.value.type === "Issued"),
	)
	const details = [
		`xcm outcome: ${execution_result.type}${execution_result.type === "Complete" ? "" : ` ${json(execution_result.value)}`}`,
		`events: ${eventNames(events)}`,
	]
	let ok = execution_result.type === "Complete"
	for (const asset of expected) {
		const hits = credits.filter((e) => {
			const payload = e.value.value
			return (
				isRecord(payload) &&
				payload.asset_id === Number(asset.assetHubAssetId) &&
				(payload.who === beneficiary || payload.owner === beneficiary)
			)
		})
		const amount = hits.reduce((sum, e) => {
			const payload = e.value.value
			return isRecord(payload) && typeof payload.amount === "bigint" ? sum + payload.amount : sum
		}, 0n)
		details.push(
			hits.length > 0
				? `${asset.symbol}: ${amount} raw units credited to the beneficiary`
				: `${asset.symbol}: NOT credited to the beneficiary`,
		)
		ok = ok && hits.length > 0
	}
	return { title, ok, details }
}

export interface VerificationReport {
	readonly checks: readonly CheckResult[]
	readonly ok: boolean
}

/** Runs the whole path once for each distinct XCM leg using the chains' `DryRunApi`s. */
export async function verifyProposal(
	assetHub: AssetHubApi,
	hydration: HydrationApi,
	proposal: Proposal,
	beneficiary: SS58String,
	assets: ReadonlyArray<{ readonly assetHubAssetId: bigint; readonly symbol: string }>,
	/**
	 * Skip the single-sweep dry run. Set when the sovereign account is funded out of band (its live
	 * DOT balance is below the per-message fee budget), so a dry run against live state would fail at
	 * `WithdrawAsset` with `FailedToTransactAsset`. The sweep is exercised for real in the e2e fork.
	 */
	skipSweepDryRun = false,
): Promise<VerificationReport> {
	const checks: CheckResult[] = []
	const root = await dryRunProposal(assetHub, proposal)
	checks.push(root.result)

	if (proposal.topUp) {
		const [forwarded] = root.forwardedToHydration
		const message = forwarded ?? versionedXcm(proposal.topUp.instructions)
		const topUp = await dryRunOnHydration(
			hydration,
			"Hydration: DOT top-up of the sovereign account",
			message,
			{
				forwardedToAssetHub: 0,
			},
		)
		checks.push(topUp.result)
	}

	if (skipSweepDryRun) {
		checks.push({
			title: "Hydration: one sweep execution",
			ok: true,
			skipped: true,
			details: [
				"the sovereign is funded out of band (live DOT balance below the fee budget); the sweep is verified in the e2e fork instead",
			],
		})
		return { checks, ok: checks.every((check) => check.ok) }
	}

	const onHydration = await dryRunOnHydration(
		hydration,
		"Hydration: one sweep execution",
		versionedXcm(proposal.periodic.instructions),
		{ forwardedToAssetHub: 1 },
	)
	checks.push(onHydration.result)
	const [back] = onHydration.forwardedToAssetHub
	if (back) checks.push(await dryRunDepositOnAssetHub(assetHub, back, beneficiary, assets))
	return { checks, ok: checks.every((check) => check.ok) }
}
