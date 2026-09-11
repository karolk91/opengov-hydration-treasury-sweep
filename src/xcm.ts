import {
	XcmV2OriginKind,
	XcmV3MultiassetFungibility,
	XcmV3WeightLimit,
	XcmV5AssetFilter,
	XcmV5Instruction,
	XcmV5Junction,
	XcmV5Junctions,
	XcmV5WildAsset,
	XcmVersionedLocation,
	XcmVersionedXcm,
} from "@polkadot-api/descriptors"
import { toSizedHex32 } from "./accounts.ts"
import type { OfflineAssetHubApi } from "./chains.ts"
import { ASSET_HUB_ASSETS_PALLET_INSTANCE, ASSET_HUB_PARA_ID, HYDRATION_PARA_ID } from "./config.ts"

export interface XcmLocation {
	parents: number
	interior: XcmV5Junctions
}

export interface XcmAsset {
	id: XcmLocation
	fun: XcmV3MultiassetFungibility
}

export interface Weight {
	ref_time: bigint
	proof_size: bigint
}

export const siblingParachainLocation = (paraId: number): XcmLocation => ({
	parents: 1,
	interior: XcmV5Junctions.X1(XcmV5Junction.Parachain(paraId)),
})

export const HYDRATION_LOCATION = siblingParachainLocation(HYDRATION_PARA_ID)
export const ASSET_HUB_LOCATION = siblingParachainLocation(ASSET_HUB_PARA_ID)

export const DOT_LOCATION: XcmLocation = { parents: 1, interior: XcmV5Junctions.Here() }

export const accountId32Location = (publicKey: Uint8Array): XcmLocation => ({
	parents: 0,
	interior: XcmV5Junctions.X1(
		XcmV5Junction.AccountId32({ network: undefined, id: toSizedHex32(publicKey) }),
	),
})

export function assetHubAssetLocation(
	assetId: bigint,
	perspective: "asset-hub" | "sibling",
): XcmLocation {
	const pallet = XcmV5Junction.PalletInstance(ASSET_HUB_ASSETS_PALLET_INSTANCE)
	const index = XcmV5Junction.GeneralIndex(assetId)
	return perspective === "asset-hub"
		? { parents: 0, interior: XcmV5Junctions.X2([pallet, index]) }
		: {
				parents: 1,
				interior: XcmV5Junctions.X3([XcmV5Junction.Parachain(ASSET_HUB_PARA_ID), pallet, index]),
			}
}

export const fungible = (id: XcmLocation, amount: bigint): XcmAsset => ({
	id,
	fun: XcmV3MultiassetFungibility.Fungible(amount),
})

export interface TransactParams {
	readonly feeBudget: bigint

	readonly call: Uint8Array

	readonly fallbackMaxWeight: Weight | undefined

	readonly refundTo: Uint8Array
}

export function buildTransactXcm(params: TransactParams): XcmV5Instruction[] {
	if (params.feeBudget <= 0n) throw new Error("The fee budget must be positive")
	const fee = fungible(DOT_LOCATION, params.feeBudget)
	return [
		XcmV5Instruction.WithdrawAsset([fee]),
		XcmV5Instruction.BuyExecution({ fees: fee, weight_limit: XcmV3WeightLimit.Unlimited() }),
		XcmV5Instruction.Transact({
			origin_kind: XcmV2OriginKind.SovereignAccount(),
			fallback_max_weight: params.fallbackMaxWeight,
			call: params.call,
		}),
		XcmV5Instruction.RefundSurplus(),
		XcmV5Instruction.DepositAsset({
			assets: XcmV5AssetFilter.Wild(XcmV5WildAsset.AllCounted(1)),
			beneficiary: accountId32Location(params.refundTo),
		}),
	]
}

export const versionedXcm = (instructions: XcmV5Instruction[]) => XcmVersionedXcm.V5(instructions)

export function buildSendToHydration(
	assetHub: OfflineAssetHubApi,
	instructions: XcmV5Instruction[],
) {
	return assetHub.tx.PolkadotXcm.send({
		dest: XcmVersionedLocation.V5(HYDRATION_LOCATION),
		message: versionedXcm(instructions),
	})
}
