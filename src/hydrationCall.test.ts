import assert from "node:assert/strict"
import { before, describe, it } from "node:test"
import { hydration } from "@polkadot-api/descriptors"
import { getOfflineApi } from "polkadot-api"
import { toHex } from "polkadot-api/utils"
import { parseAccount, siblingSovereignAccount, toSs58 } from "./accounts.ts"
import type { OfflineHydrationApi } from "./chains.ts"
import { DEFAULT_HOLDER, HYDRATION_SS58_PREFIX } from "./config.ts"
import { activeCurrencies, buildTopUpCall, buildTransferChunkCall } from "./hydrationCall.ts"

const BENEFICIARY = `0x${"42".repeat(32)}`

describe("hydration calls", () => {
	let api: OfflineHydrationApi
	before(async () => {
		api = await getOfflineApi(hydration)
	})

	it("builds Proxy.proxy(holder, XTokens.transfer_multicurrencies) with auto-selected fee item", () => {
		const beneficiary = parseAccount(BENEFICIARY)
		const call = buildTransferChunkCall(api, DEFAULT_HOLDER, {
			currencies: [
				[10, 5_000_000_000n],
				[22, 7_000_000_000n],
			],
			beneficiary,
		})
		assert.equal(call.decodedCall.type, "Proxy")
		assert.equal(call.decodedCall.value.type, "proxy")
		// Proxy.proxy(real = holder, force_proxy_type = None) followed by XTokens.transfer_multicurrencies.
		assert.equal(
			toHex(call.encodedData.slice(0, 37)),
			`0x1d00${toHex(parseAccount(DEFAULT_HOLDER)).slice(2)}008904`,
		)
		const inner = call.decodedCall.value.value as {
			call: {
				type: string
				value: { type: string; value: { fee_item: number; currencies: Array<[number, bigint]> } }
			}
		}
		assert.equal(inner.call.type, "XTokens")
		assert.equal(inner.call.value.type, "transfer_multicurrencies")
		assert.equal(inner.call.value.value.fee_item, 1)
		assert.deepEqual(inner.call.value.value.currencies, [
			[10, 5_000_000_000n],
			[22, 7_000_000_000n],
		])
	})

	it("drops zero amounts and picks the largest remaining asset for fees", () => {
		assert.deepEqual(
			activeCurrencies([
				[10, 0n],
				[22, 5n],
				[5, 9n],
			]),
			{
				currencies: [
					[22, 5n],
					[5, 9n],
				],
				feeItem: 1,
			},
		)
		assert.throws(() => activeCurrencies([[10, 0n]]), /at least one asset/)
	})

	it("builds the DOT top-up as Proxy.proxy(holder, Currencies.transfer)", () => {
		const sovereign = toSs58(siblingSovereignAccount(1000), HYDRATION_SS58_PREFIX)
		const call = buildTopUpCall(api, DEFAULT_HOLDER, sovereign, 5, 5_000_000_000n)
		assert.equal(call.decodedCall.type, "Proxy")
		const inner = call.decodedCall.value.value as {
			real: string
			call: {
				type: string
				value: { type: string; value: { dest: string; currency_id: number; amount: bigint } }
			}
		}
		assert.equal(inner.call.type, "Currencies")
		assert.equal(inner.call.value.type, "transfer")
		assert.equal(inner.call.value.value.currency_id, 5)
		assert.equal(inner.call.value.value.amount, 5_000_000_000n)
		assert.throws(() => buildTopUpCall(api, DEFAULT_HOLDER, sovereign, 5, 0n))
	})
})
