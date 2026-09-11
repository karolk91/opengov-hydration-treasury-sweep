const textDecoder = new TextDecoder()

export function formatUnits(amount: bigint, decimals: number, symbol?: string): string {
	const negative = amount < 0n
	const abs = negative ? -amount : amount
	const base = 10n ** BigInt(decimals)
	const whole = abs / base
	const fraction = abs % base
	const wholeStr = whole.toLocaleString("en-US")
	const fractionStr = decimals > 0 ? `.${fraction.toString().padStart(decimals, "0")}` : ""
	const sign = negative ? "-" : ""
	return `${sign}${wholeStr}${fractionStr}${symbol ? ` ${symbol}` : ""}`
}

export function parseUnits(input: string, decimals: number): bigint {
	const match = /^(\d+)(?:\.(\d+))?$/.exec(input.trim().replaceAll(",", ""))
	if (!match) throw new Error(`Invalid amount: ${input}`)
	const [, whole = "0", fraction = ""] = match
	if (fraction.length > decimals) {
		throw new Error(`Amount ${input} has more than ${decimals} fractional digits`)
	}
	return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0")
}

export function bytesToUtf8(bytes: Uint8Array | undefined): string {
	return bytes ? textDecoder.decode(bytes) : ""
}

export function heading(title: string): string {
	return `\n${title}\n${"=".repeat(title.length)}`
}
