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

interface AnyEvent {
	readonly type: string
	readonly value: { readonly type: string; readonly value: unknown }
}

export interface CheckResult {
	readonly title: string
	readonly ok: boolean
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

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function proxyOutcome(events: readonly AnyEvent[]): { ok: boolean; error?: string } | undefined {
	const event = events.find(
		(record) => record.type === "Proxy" && record.value.type === "ProxyExecuted",
	)
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
	const scheduledEventCount = events.filter(
		(record) => record.type === "Scheduler" && record.value.type === "Scheduled",
	).length
	const expectedScheduledEvents = 1
	const forwardedToHydration = forwarded_xcms
		.filter(([dest]) => isParachain(dest, HYDRATION_PARA_ID))
		.flatMap(([, xcms]) => xcms)
	const details = [
		`dispatch: ${execution_result.success ? "ok" : `error ${json(execution_result.value.error)}`}`,
		`events: ${eventNames(events)}`,
		`scheduler tasks created: ${scheduledEventCount} (expected ${expectedScheduledEvents})`,
		`XCMs forwarded to Hydration now: ${forwardedToHydration.length} (expected ${proposal.topUp ? 1 : 0})`,
	]
	const ok =
		execution_result.success &&
		scheduledEventCount === expectedScheduledEvents &&
		forwardedToHydration.length === (proposal.topUp ? 1 : 0)
	return { result: { title, ok, details }, forwardedToHydration }
}

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
	const credits = events.filter(
		(record) =>
			record.type === "Assets" &&
			(record.value.type === "Deposited" || record.value.type === "Issued"),
	)
	const details = [
		`xcm outcome: ${execution_result.type}${execution_result.type === "Complete" ? "" : ` ${json(execution_result.value)}`}`,
		`events: ${eventNames(events)}`,
	]
	let ok = execution_result.type === "Complete"
	for (const asset of expected) {
		const hits = credits.filter((record) => {
			const payload = record.value.value
			return (
				isRecord(payload) &&
				payload.asset_id === Number(asset.assetHubAssetId) &&
				(payload.who === beneficiary || payload.owner === beneficiary)
			)
		})
		const amount = hits.reduce((sum, record) => {
			const payload = record.value.value
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

export async function verifyProposal(
	assetHub: AssetHubApi,
	hydration: HydrationApi,
	proposal: Proposal,
	beneficiary: SS58String,
	assets: ReadonlyArray<{ readonly assetHubAssetId: bigint; readonly symbol: string }>,
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
