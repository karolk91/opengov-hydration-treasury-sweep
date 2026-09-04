import { XcmVersionedAssetId, type XcmVersionedXcm } from "@polkadot-api/descriptors"
import type { SS58String } from "polkadot-api"
import type { HydrationApi } from "./chains.ts"
import { bytesToUtf8 } from "./format.ts"
import type { Weight, XcmLocation } from "./xcm.ts"

/** `orml_tokens::AccountData`. */
export interface OrmlAccountData {
	readonly free: bigint
	readonly reserved: bigint
	readonly frozen: bigint
}

export interface HydrationAssetInfo {
	readonly id: number
	readonly symbol: string
	readonly decimals: number | undefined
	readonly existentialDeposit: bigint
}

/** Amount `orml_tokens` lets the account withdraw: free balance not covered by a freeze. */
export function withdrawable(data: OrmlAccountData): bigint {
	return data.free > data.frozen ? data.free - data.frozen : 0n
}

/** Hydration's asset registry maps XCM locations to its local asset ids. */
export function resolveAssetIdByLocation(
	api: HydrationApi,
	location: XcmLocation,
): Promise<number | undefined> {
	return api.query.AssetRegistry.LocationAssets.getValue(location)
}

export async function getAssetInfo(
	api: HydrationApi,
	assetId: number,
): Promise<HydrationAssetInfo | undefined> {
	const details = await api.query.AssetRegistry.Assets.getValue(assetId)
	if (!details) return undefined
	return {
		id: assetId,
		symbol: bytesToUtf8(details.symbol),
		decimals: details.decimals,
		existentialDeposit: details.existential_deposit,
	}
}

export function getTokenBalance(
	api: HydrationApi,
	account: SS58String,
	assetId: number,
): Promise<OrmlAccountData> {
	return api.query.Tokens.Accounts.getValue(account, assetId)
}

export interface TokenHolding {
	readonly assetId: number
	readonly data: OrmlAccountData
}

/** Every `orml_tokens` balance of `account` (the native HDX balance lives in `System.Account`). */
export async function getAllTokenHoldings(
	api: HydrationApi,
	account: SS58String,
): Promise<TokenHolding[]> {
	const entries: Array<{ keyArgs: [SS58String, number]; value: OrmlAccountData }> =
		await api.query.Tokens.Accounts.getEntries(account)
	const holdings: TokenHolding[] = entries.map((entry) => ({
		assetId: entry.keyArgs[1],
		data: entry.value,
	}))
	return holdings.sort((a, b) => a.assetId - b.assetId)
}

export async function getNativeBalance(
	api: HydrationApi,
	account: SS58String,
): Promise<OrmlAccountData> {
	const { data } = await api.query.System.Account.getValue(account)
	return { free: data.free, reserved: data.reserved, frozen: data.frozen }
}

export interface ProxyDelegate {
	readonly delegate: SS58String
	readonly proxyType: string
	readonly delay: number
}

export async function getProxyDelegates(
	api: HydrationApi,
	account: SS58String,
): Promise<ProxyDelegate[]> {
	const [delegates] = await api.query.Proxy.Proxies.getValue(account)
	return delegates.map((entry) => ({
		delegate: entry.delegate,
		proxyType: entry.proxy_type.type,
		delay: entry.delay,
	}))
}

export interface CircuitBreakerState {
	/** Global XCM egress limit, in HDX units, over a sliding `windowMs`. */
	readonly limit: bigint
	readonly windowMs: bigint
	/** Egress accumulated so far (HDX units), already decayed to `nowMs`. */
	readonly accumulator: bigint
	readonly lockdownUntilMs: bigint | undefined
	readonly ignored: boolean
	readonly nowMs: bigint
}

/**
 * The circuit breaker's accumulator as of `nowMs`: it decays linearly to zero over `windowMs`
 * from its last on-chain update. Mirrors `pallet_circuit_breaker`'s decay rule.
 */
export function decayAccumulator(
	value: bigint,
	lastUpdateMs: bigint,
	nowMs: bigint,
	windowMs: bigint,
): bigint {
	if (windowMs <= 0n) return value
	const elapsed = nowMs > lastUpdateMs ? nowMs - lastUpdateMs : 0n
	if (elapsed >= windowMs) return 0n
	return value - (value * elapsed) / windowMs
}

/**
 * Hydration's `pallet_circuit_breaker` caps the value (in HDX) that may leave the chain through
 * XCM within a sliding window; the accumulator decays linearly over that window.
 */
export async function getCircuitBreakerState(
	api: HydrationApi,
): Promise<CircuitBreakerState | undefined> {
	const [config, [raw, updatedMs], lockdownUntilMs, ignored, nowMs] = await Promise.all([
		api.query.CircuitBreaker.GlobalWithdrawLimitConfig.getValue(),
		api.query.CircuitBreaker.WithdrawLimitAccumulator.getValue(),
		api.query.CircuitBreaker.WithdrawLockdownUntil.getValue(),
		api.query.CircuitBreaker.IgnoreWithdrawLimit.getValue(),
		api.query.Timestamp.Now.getValue(),
	])
	if (!config) return undefined
	return {
		limit: config.limit,
		windowMs: config.window,
		accumulator: decayAccumulator(raw, updatedMs, nowMs, config.window),
		lockdownUntilMs,
		ignored,
		nowMs,
	}
}

export interface XcmFeeQuote {
	readonly weight: Weight
	/** Fee for `weight` in each requested asset (raw units), `undefined` if the runtime cannot price it. */
	readonly fees: ReadonlyMap<string, bigint | undefined>
}

/** Weighs a message with `XcmPaymentApi` and prices that weight in each of the given assets. */
export async function quoteXcmFees(
	api: HydrationApi,
	message: XcmVersionedXcm,
	assets: ReadonlyMap<string, XcmLocation>,
): Promise<XcmFeeQuote> {
	const weight = await api.apis.XcmPaymentApi.query_xcm_weight(message)
	if (!weight.success) throw new Error(`Hydration cannot weigh the XCM: ${weight.value.type}`)
	const fees = new Map<string, bigint | undefined>()
	for (const [label, location] of assets) {
		const fee = await api.apis.XcmPaymentApi.query_weight_to_asset_fee(
			weight.value,
			XcmVersionedAssetId.V5(location),
		)
		fees.set(label, fee.success ? fee.value : undefined)
	}
	return { weight: weight.value, fees }
}
