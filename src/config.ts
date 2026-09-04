import type { SS58String } from "polkadot-api"

export const POLKADOT_SS58_PREFIX = 0
export const HYDRATION_SS58_PREFIX = 63

export const ASSET_HUB_PARA_ID = 1000
export const COLLECTIVES_PARA_ID = 1001
export const HYDRATION_PARA_ID = 2034

/** Index of `pallet_assets` (trust-backed assets) in the Polkadot Asset Hub runtime. */
export const ASSET_HUB_ASSETS_PALLET_INSTANCE = 50

export const DOT_DECIMALS = 10
export const HDX_DECIMALS = 12

export type StablecoinSymbol = "USDT" | "USDC"

export interface Stablecoin {
	readonly symbol: StablecoinSymbol
	/** `pallet_assets` id on Polkadot Asset Hub. */
	readonly assetHubAssetId: bigint
	/** Well-known Hydration asset-registry id. Only used as a cross-check; the id is resolved on-chain. */
	readonly expectedHydrationAssetId: number
	readonly decimals: number
}

export const STABLECOINS: readonly Stablecoin[] = [
	{ symbol: "USDT", assetHubAssetId: 1984n, expectedHydrationAssetId: 10, decimals: 6 },
	{ symbol: "USDC", assetHubAssetId: 1337n, expectedHydrationAssetId: 22, decimals: 6 },
]

/**
 * The pure proxy on Hydration that holds the stablecoins (USDT/USDC) and DOT for fees. Polkadot
 * Asset Hub's sovereign account on Hydration is one of its `Any` delegates.
 */
export const DEFAULT_HOLDER: SS58String = "7N4oFqXKgeTXo6CMSY9BVZdHP5J3RhQXY77Fe7qmQwjcxa1w"

export const DEFAULT_ENDPOINTS = {
	assetHub: [
		"wss://polkadot-asset-hub-rpc.polkadot.io",
		"wss://asset-hub-polkadot-rpc.n.dwellir.com",
	],
	hydration: ["wss://hydration-rpc.n.dwellir.com", "wss://rpc.hydradx.cloud"],
	collectives: ["wss://polkadot-collectives-rpc.polkadot.io"],
} as const

/** `networkId` / `endpoint` values understood by https://dev.papi.how/extrinsics links. */
export const PAPI_HOW = {
	ahp: { networkId: "polkadot_asset_hub", endpoint: "wss://asset-hub-polkadot-rpc.dwellir.com" },
	collectives: {
		networkId: "polkadot_collectives",
		endpoint: "wss://polkadot-collectives-rpc.polkadot.io",
	},
} as const

/**
 * Treasury pot on Polkadot Asset Hub (`PalletId(*b"py/trsry")`). The program derives the account
 * from the on-chain constant; this value is only used to warn when the derived account does not
 * match it.
 */
export const EXPECTED_ASSET_HUB_TREASURY: SS58String =
	"13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB"

/** Label hashed into the name of the Asset Hub scheduler task (`Scheduler.cancel_named` target). */
export const SCHEDULER_TASK_LABEL = "opengov-hydration-treasury-sweep"

/** Fellowship proposals up to this size can be submitted `Inline`, without a preimage. */
export const INLINE_PREIMAGE_LIMIT = 128

/** Enactment delay used for the Fellowship (whitelisting) referendum, as in `opengov-cli`. */
export const FELLOWSHIP_ENACTMENT_AFTER = 10

/** Defaults for the chunked sweep (see README for the reasoning). */
export const DEFAULTS = {
	/** Per-asset chunk used only when the circuit breaker cannot be read (no limit or no price). */
	chunkFallback: "12500",
	/** Time between two executions. */
	intervalHours: 1,
	/** DOT withdrawn from the sovereign account to pay for one XCM execution on Hydration. */
	feeBudgetDot: "0.02",
	/**
	 * Optional one-time DOT transfer from the holder to the sovereign account so that all executions
	 * can be paid; "0" (default) omits the top-up leg — the sovereign account is then expected to be
	 * funded out of band (see `--assume-sovereign-dot`).
	 */
	topUpDot: "0",
	/** Extra executions scheduled beyond the needed ones; they fail harmlessly once the holder is empty. */
	extraExecutions: 16,
	/** Warn when our steady-state load on the circuit breaker exceeds this share of its limit. */
	maxFootprintShare: 0.15,
} as const
