import {
	XcmV3WeightLimit,
	XcmV5Junction,
	XcmV5Junctions,
	XcmVersionedLocation,
} from "@polkadot-api/descriptors"
import type { SS58String } from "polkadot-api"
import { toSizedHex32 } from "./accounts.ts"
import type { OfflineHydrationApi } from "./chains.ts"
import { ASSET_HUB_PARA_ID } from "./config.ts"

export interface EncodedCall {
	readonly encodedData: Uint8Array
	readonly decodedCall: import("polkadot-api").TxCallData
}

export interface TransferChunk {
	readonly currencies: ReadonlyArray<readonly [assetId: number, amount: bigint]>

	readonly beneficiary: Uint8Array
}

export function activeCurrencies(currencies: TransferChunk["currencies"]): {
	currencies: Array<[number, bigint]>
	feeItem: number
} {
	const active = currencies
		.filter(([, amount]) => amount > 0n)
		.map(([assetId, amount]) => [assetId, amount] as [number, bigint])
	if (active.length === 0) throw new Error("A transfer chunk must move at least one asset")
	let feeItem = 0
	active.forEach(([, amount], i) => {
		const [, best] = active[feeItem] ?? [0, 0n]
		if (amount > best) feeItem = i
	})
	return { currencies: active, feeItem }
}

export function buildTransferChunkCall(
	hydration: OfflineHydrationApi,
	holder: SS58String,
	chunk: TransferChunk,
): EncodedCall {
	const { currencies, feeItem } = activeCurrencies(chunk.currencies)
	const transfer = hydration.tx.XTokens.transfer_multicurrencies({
		currencies,
		fee_item: feeItem,
		dest: XcmVersionedLocation.V5({
			parents: 1,
			interior: XcmV5Junctions.X2([
				XcmV5Junction.Parachain(ASSET_HUB_PARA_ID),
				XcmV5Junction.AccountId32({ network: undefined, id: toSizedHex32(chunk.beneficiary) }),
			]),
		}),
		dest_weight_limit: XcmV3WeightLimit.Unlimited(),
	})
	return hydration.tx.Proxy.proxy({
		real: holder,
		force_proxy_type: undefined,
		call: transfer.decodedCall,
	})
}

export function buildTopUpCall(
	hydration: OfflineHydrationApi,
	holder: SS58String,
	to: SS58String,
	assetId: number,
	amount: bigint,
): EncodedCall {
	if (amount <= 0n) throw new Error("The top-up amount must be positive")
	const transfer = hydration.tx.Currencies.transfer({ dest: to, currency_id: assetId, amount })
	return hydration.tx.Proxy.proxy({
		real: holder,
		force_proxy_type: undefined,
		call: transfer.decodedCall,
	})
}
