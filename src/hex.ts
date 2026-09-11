interface BinaryLike {
	asOpaqueBytes?: () => Uint8Array
	asBytes?: () => Uint8Array
	asHex?: () => string
	encoded?: unknown
}

export function toHexString(value: unknown): string | undefined {
	if (value == null) return undefined
	if (typeof value === "string") return value
	if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`
	const binary = value as BinaryLike
	if (typeof binary.asHex === "function") return binary.asHex()
	return String(value)
}

export function hexWithoutPrefix(value: unknown): string {
	return toHexString(value)?.replace(/^0x/, "") ?? ""
}

export function hexToBytes(hex: string): Uint8Array {
	return new Uint8Array(Buffer.from(hex.replace(/^0x/, ""), "hex"))
}

export function toBytes(value: unknown): Uint8Array {
	if (value == null) throw new Error("cannot convert null to bytes")
	if (value instanceof Uint8Array) return value
	const binary = value as BinaryLike
	if (typeof binary.asOpaqueBytes === "function") return binary.asOpaqueBytes()
	if (typeof binary.asBytes === "function") return binary.asBytes()
	if (binary.encoded !== undefined) return toBytes(binary.encoded)
	if (typeof binary.asHex === "function") return hexToBytes(binary.asHex())
	throw new Error(`cannot convert value to bytes: ${String(value)}`)
}
