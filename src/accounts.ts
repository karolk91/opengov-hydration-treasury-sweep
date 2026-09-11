import { AccountId, getSs58AddressInfo, type SizedHex, type SS58String } from "polkadot-api"
import { fromHex, toHex } from "polkadot-api/utils"

const ACCOUNT_ID_LENGTH = 32
const PALLET_ID_LENGTH = 8
const textEncoder = new TextEncoder()

function padToAccountId(prefix: Uint8Array, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(ACCOUNT_ID_LENGTH)
	out.set(prefix, 0)
	out.set(body, prefix.length)
	return out
}

export function siblingSovereignAccount(paraId: number): Uint8Array {
	const id = new Uint8Array(4)
	new DataView(id.buffer).setUint32(0, paraId, true)
	return padToAccountId(textEncoder.encode("sibl"), id)
}

export function palletAccount(palletId: Uint8Array): Uint8Array {
	if (palletId.length !== PALLET_ID_LENGTH) {
		throw new Error(`A PalletId is ${PALLET_ID_LENGTH} bytes, got ${palletId.length}`)
	}
	return padToAccountId(textEncoder.encode("modl"), palletId)
}

export function toSs58(publicKey: Uint8Array, ss58Prefix: number): SS58String {
	return AccountId(ss58Prefix).dec(publicKey)
}

export function parseAccount(input: string): Uint8Array {
	if (input.startsWith("0x")) {
		const bytes = fromHex(input)
		if (bytes.length !== ACCOUNT_ID_LENGTH) {
			throw new Error(`Expected a ${ACCOUNT_ID_LENGTH}-byte account id, got ${bytes.length} bytes`)
		}
		return bytes
	}
	const info = getSs58AddressInfo(input)
	if (!info.isValid) throw new Error(`Invalid SS58 address: ${input}`)
	return info.publicKey
}

export function toSizedHex32(bytes: Uint8Array): SizedHex<32> {
	if (bytes.length !== ACCOUNT_ID_LENGTH) {
		throw new Error(`Expected ${ACCOUNT_ID_LENGTH} bytes, got ${bytes.length}`)
	}
	return toHex(bytes)
}

export function bytesEqual(first: Uint8Array, second: Uint8Array): boolean {
	return (
		first.length === second.length && first.every((byte, position) => byte === second[position])
	)
}
