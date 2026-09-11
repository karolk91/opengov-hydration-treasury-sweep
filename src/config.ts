import type { SS58String } from "polkadot-api"

export const POLKADOT_SS58_PREFIX = 0
export const HYDRATION_SS58_PREFIX = 63

export const ASSET_HUB_PARA_ID = 1000
export const COLLECTIVES_PARA_ID = 1001
export const HYDRATION_PARA_ID = 2034

export const ASSET_HUB_ASSETS_PALLET_INSTANCE = 50

export const DOT_DECIMALS = 10
export const HDX_DECIMALS = 12

export type StablecoinSymbol = "USDT" | "USDC"

export interface Stablecoin {
	readonly symbol: StablecoinSymbol

	readonly assetHubAssetId: bigint

	readonly expectedHydrationAssetId: number
	readonly decimals: number
}

export const STABLECOINS: readonly Stablecoin[] = [
	{ symbol: "USDT", assetHubAssetId: 1984n, expectedHydrationAssetId: 10, decimals: 6 },
	{ symbol: "USDC", assetHubAssetId: 1337n, expectedHydrationAssetId: 22, decimals: 6 },
]

export const DEFAULT_HOLDER: SS58String = "7N4oFqXKgeTXo6CMSY9BVZdHP5J3RhQXY77Fe7qmQwjcxa1w"

export const DEFAULT_ENDPOINTS = {
	assetHub: [
		"wss://polkadot-asset-hub-rpc.polkadot.io",
		"wss://asset-hub-polkadot-rpc.n.dwellir.com",
	],
	hydration: ["wss://hydration-rpc.n.dwellir.com", "wss://rpc.hydradx.cloud"],
	collectives: ["wss://polkadot-collectives-rpc.polkadot.io"],
} as const

export const PAPI_HOW = {
	ahp: { networkId: "polkadot_asset_hub", endpoint: "wss://asset-hub-polkadot-rpc.dwellir.com" },
	collectives: {
		networkId: "polkadot_collectives",
		endpoint: "wss://polkadot-collectives-rpc.polkadot.io",
	},
} as const

export const EXPECTED_ASSET_HUB_TREASURY: SS58String =
	"13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB"

export const SCHEDULER_TASK_LABEL = "opengov-hydration-treasury-sweep"

export const INLINE_PREIMAGE_LIMIT = 128

export const FELLOWSHIP_ENACTMENT_AFTER = 10

export const DEFAULTS = {
	chunkFallback: "12500",

	intervalHours: 1,

	feeBudgetDot: "0.02",

	topUpDot: "0",

	extraExecutions: 16,

	maxFootprintShare: 0.15,
} as const
