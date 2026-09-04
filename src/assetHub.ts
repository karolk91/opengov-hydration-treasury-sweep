import type { PolkadotClient, SS58String } from "polkadot-api"
import { fromHex } from "polkadot-api/utils"
import { palletAccount } from "./accounts.ts"
import type { AssetHubApi } from "./chains.ts"
import { bytesToUtf8 } from "./format.ts"
import { DOT_LOCATION, type XcmLocation } from "./xcm.ts"

/** The treasury pot, derived from the `Treasury.PalletId` runtime constant. */
export async function getTreasuryAccount(api: AssetHubApi): Promise<Uint8Array> {
	const palletId = await api.constants.Treasury.PalletId()
	return palletAccount(fromHex(palletId))
}

export async function getAssetBalance(
	api: AssetHubApi,
	assetId: number,
	account: SS58String,
): Promise<bigint> {
	const holding = await api.query.Assets.Account.getValue(assetId, account)
	return holding?.balance ?? 0n
}

export interface AssetHubAssetMetadata {
	readonly symbol: string
	readonly decimals: number
}

export async function getAssetMetadata(
	api: AssetHubApi,
	assetId: number,
): Promise<AssetHubAssetMetadata> {
	const metadata = await api.query.Assets.Metadata.getValue(assetId)
	return { symbol: bytesToUtf8(metadata.symbol), decimals: metadata.decimals }
}

/** Whether `AssetConversion` has a DOT pool for the asset, i.e. whether it can pay XCM fees. */
export async function hasDotPool(api: AssetHubApi, asset: XcmLocation): Promise<boolean> {
	return (await api.query.AssetConversion.Pools.getValue([DOT_LOCATION, asset])) !== undefined
}

/** XCM version Asset Hub will use when sending to `paraId`, if it has negotiated one. */
export async function supportedXcmVersionFor(
	api: AssetHubApi,
	paraId: number,
): Promise<number | undefined> {
	const entries = await api.query.PolkadotXcm.SupportedVersion.getEntries()
	for (const {
		keyArgs: [, location],
		value,
	} of entries) {
		const { parents, interior } = location.value
		if (parents !== 1 || interior.type !== "X1") continue
		const junction = interior.value
		if (junction.type === "Parachain" && junction.value === paraId) return value
	}
	return undefined
}

/**
 * Milliseconds per *scheduler* block. Asset Hub's `pallet_scheduler` counts relay-chain blocks
 * (`BlockNumberProvider = RelaychainDataProvider`), so the clock is measured from
 * `ParachainSystem.LastRelayChainBlockNumber` over the last `sample` Asset Hub blocks instead of
 * Asset Hub's own (elastic-scaling) block production. Falls back to `fallbackMs` (6 s).
 */
export async function measureSchedulerBlockTimeMs(
	client: PolkadotClient,
	api: AssetHubApi,
	sample = 600,
	fallbackMs = 6_000,
): Promise<number> {
	try {
		const finalized = await client.getFinalizedBlock()
		const olderHash = await api.query.System.BlockHash.getValue(finalized.number - sample)
		const [now, then, relayNow, relayThen] = await Promise.all([
			api.query.Timestamp.Now.getValue({ at: finalized.hash }),
			api.query.Timestamp.Now.getValue({ at: olderHash }),
			api.query.ParachainSystem.LastRelayChainBlockNumber.getValue({ at: finalized.hash }),
			api.query.ParachainSystem.LastRelayChainBlockNumber.getValue({ at: olderHash }),
		])
		const relayBlocks = relayNow - relayThen
		const measured = relayBlocks > 0 ? Number(now - then) / relayBlocks : Number.NaN
		if (measured >= 500 && measured <= 60_000) return measured
		console.warn(
			`warning: implausible measured scheduler block time (${measured}ms), using ${fallbackMs}ms`,
		)
	} catch (error: unknown) {
		console.warn(
			`warning: could not measure the scheduler block time (${error instanceof Error ? error.message : String(error)}), using ${fallbackMs}ms`,
		)
	}
	return fallbackMs
}
