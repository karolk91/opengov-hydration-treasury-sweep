import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { toHex } from "polkadot-api/utils"
import {
	bytesEqual,
	palletAccount,
	parseAccount,
	siblingSovereignAccount,
	toSizedHex32,
	toSs58,
} from "./accounts.ts"
import {
	EXPECTED_ASSET_HUB_TREASURY,
	HYDRATION_SS58_PREFIX,
	POLKADOT_SS58_PREFIX,
} from "./config.ts"

describe("siblingSovereignAccount", () => {
	it("derives `sibl` ++ u32 LE, zero padded", () => {
		assert.equal(
			toHex(siblingSovereignAccount(1000)),
			"0x7369626ce8030000000000000000000000000000000000000000000000000000",
		)
		assert.equal(
			toHex(siblingSovereignAccount(2034)),
			"0x7369626cf2070000000000000000000000000000000000000000000000000000",
		)
	})

	it("round-trips through SS58 with any prefix", () => {
		const key = siblingSovereignAccount(1000)
		for (const prefix of [POLKADOT_SS58_PREFIX, HYDRATION_SS58_PREFIX]) {
			assert.ok(bytesEqual(parseAccount(toSs58(key, prefix)), key))
		}
	})
})

describe("palletAccount", () => {
	it("derives the well-known treasury pot from `py/trsry`", () => {
		const account = palletAccount(new TextEncoder().encode("py/trsry"))
		assert.equal(toSs58(account, POLKADOT_SS58_PREFIX), EXPECTED_ASSET_HUB_TREASURY)
	})

	it("rejects pallet ids that are not 8 bytes", () => {
		assert.throws(() => palletAccount(new Uint8Array(7)))
	})
})

describe("parseAccount", () => {
	it("accepts 32-byte hex and SS58", () => {
		const hex = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
		const key = parseAccount(hex)
		assert.equal(toSizedHex32(key), hex)
		assert.equal(
			toSs58(key, POLKADOT_SS58_PREFIX),
			"15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
		)
		assert.throws(() => parseAccount("0x1234"))
		assert.throws(() => parseAccount("not-an-address"))
	})
})
