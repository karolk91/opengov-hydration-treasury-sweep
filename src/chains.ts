import { ahp, collectives, hydration } from "@polkadot-api/descriptors"
import { createClient, getOfflineApi, type PolkadotClient, type TypedApi } from "polkadot-api"
import { getWsProvider } from "polkadot-api/ws"

export type AssetHubApi = TypedApi<typeof ahp>
export type HydrationApi = TypedApi<typeof hydration>

export type OfflineAssetHubApi = Awaited<ReturnType<typeof getOfflineApi<typeof ahp>>>
export type OfflineCollectivesApi = Awaited<ReturnType<typeof getOfflineApi<typeof collectives>>>
export type OfflineHydrationApi = Awaited<ReturnType<typeof getOfflineApi<typeof hydration>>>

export interface OfflineApis {
	readonly assetHub: OfflineAssetHubApi
	readonly collectives: OfflineCollectivesApi
	readonly hydration: OfflineHydrationApi
}

export async function getOfflineApis(): Promise<OfflineApis> {
	const [assetHub, collectivesApi, hydrationApi] = await Promise.all([
		getOfflineApi(ahp),
		getOfflineApi(collectives),
		getOfflineApi(hydration),
	])
	return { assetHub, collectives: collectivesApi, hydration: hydrationApi }
}

export interface ChainConnection<Api> {
	readonly client: PolkadotClient
	readonly api: Api
}

export function connectAssetHub(endpoints: readonly string[]): ChainConnection<AssetHubApi> {
	const client = createClient(getWsProvider([...endpoints]))
	return { client, api: client.getTypedApi(ahp) }
}

export function connectHydration(endpoints: readonly string[]): ChainConnection<HydrationApi> {
	const client = createClient(getWsProvider([...endpoints]))
	return { client, api: client.getTypedApi(hydration) }
}
