import type { PolkadotClient, SS58String } from "polkadot-api"
import { fromHex } from "polkadot-api/utils"
import { palletAccount } from "./accounts.ts"
import type { AssetHubApi } from "./chains.ts"
import { bytesToUtf8 } from "./format.ts"
import { DOT_LOCATION, type XcmLocation } from "./xcm.ts"

export async function getTreasuryAccount(api: AssetHubApi): Promise<Uint8Array> {
	const palletId = await api.constants.Treasury.PalletId()
	return palletAccount(fromHex(palletId))
}

export async function getAssetBalance(
	api: AssetHubApi,
	assetId: number,
	account: SS58String,
): Promise<bigint> {
	const assetAccount = await api.query.Assets.Account.getValue(assetId, account)
	return assetAccount?.balance ?? 0n
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

export async function hasDotPool(api: AssetHubApi, asset: XcmLocation): Promise<boolean> {
	return (await api.query.AssetConversion.Pools.getValue([DOT_LOCATION, asset])) !== undefined
}

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

export async function measureSchedulerBlockTimeMs(
	client: PolkadotClient,
	api: AssetHubApi,
	sample = 600,
	fallbackMs = 6_000,
): Promise<number> {
	try {
		const finalizedBlock = await client.getFinalizedBlock()
		const olderHash = await api.query.System.BlockHash.getValue(finalizedBlock.number - sample)
		const [now, then, relayNow, relayThen] = await Promise.all([
			api.query.Timestamp.Now.getValue({ at: finalizedBlock.hash }),
			api.query.Timestamp.Now.getValue({ at: olderHash }),
			api.query.ParachainSystem.LastRelayChainBlockNumber.getValue({ at: finalizedBlock.hash }),
			api.query.ParachainSystem.LastRelayChainBlockNumber.getValue({ at: olderHash }),
		])
		const relayBlocks = relayNow - relayThen
		const measuredMs = relayBlocks > 0 ? Number(now - then) / relayBlocks : Number.NaN
		if (measuredMs >= 500 && measuredMs <= 60_000) return measuredMs
		console.warn(
			`warning: implausible measured scheduler block time (${measuredMs}ms), using ${fallbackMs}ms`,
		)
	} catch (error: unknown) {
		console.warn(
			`warning: could not measure the scheduler block time (${error instanceof Error ? error.message : String(error)}), using ${fallbackMs}ms`,
		)
	}
	return fallbackMs
}
