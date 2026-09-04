import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { toHex } from "polkadot-api/utils"
import { PAPI_HOW } from "./config.ts"
import type { CallInfo, ReferendumCalls } from "./referendum.ts"

export function papiHowLink(call: CallInfo): string {
	const { networkId, endpoint } = PAPI_HOW[call.chain]
	return `https://dev.papi.how/extrinsics#data=${toHex(call.encodedData)}&networkId=${networkId}&endpoint=${encodeURIComponent(endpoint)}`
}

export const CHAIN_NAMES = {
	ahp: "Polkadot Asset Hub",
	collectives: "Polkadot Collectives",
} as const

export interface PrintOptions {
	/** Calls longer than this are printed as hash + file reference only. */
	readonly lengthLimit: number
}

export function printCall(call: CallInfo, options: PrintOptions): void {
	console.log(`\n${call.title} (${CHAIN_NAMES[call.chain]}):`)
	console.log(`  hash:   ${call.hash}`)
	console.log(`  length: ${call.length} bytes`)
	if (call.length > options.lengthLimit) {
		console.log(`  call data exceeds ${options.lengthLimit} bytes; see the written .call file`)
		return
	}
	console.log(`  data:   ${toHex(call.encodedData)}`)
	console.log(`  link:   ${papiHowLink(call)}`)
}

export function printReferendumCalls(calls: ReferendumCalls, options: PrintOptions): void {
	if (calls.preimageForWhitelistCall) printCall(calls.preimageForWhitelistCall, options)
	if (calls.fellowshipReferendumSubmission) printCall(calls.fellowshipReferendumSubmission, options)
	printCall(calls.preimageForPublicReferendum, options)
	printCall(calls.publicReferendumSubmission, options)
	for (const batch of calls.batches) printCall(batch, options)
}

function fileName(call: CallInfo): string {
	const slug = call.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
	return `${call.chain}-${slug}.call`
}

/** Writes one call as a `0x`-prefixed hex file (the format `opengov-cli` uses) and returns the path. */
export function writeCallFile(dir: string, call: CallInfo): string {
	mkdirSync(dir, { recursive: true })
	const path = join(dir, fileName(call))
	writeFileSync(path, `${toHex(call.encodedData)}\n`)
	return path
}

/** Writes every call as a `0x`-prefixed hex file (the format `opengov-cli` uses) and returns the paths. */
export function writeCallFiles(dir: string, calls: ReferendumCalls): string[] {
	mkdirSync(dir, { recursive: true })
	const all = [
		calls.proposal,
		calls.preimageForWhitelistCall,
		calls.fellowshipReferendumSubmission,
		calls.preimageForPublicReferendum,
		calls.publicReferendumSubmission,
		...calls.batches,
	].filter((call): call is CallInfo => call !== undefined)
	return all.map((call) => {
		const path = join(dir, fileName(call))
		writeFileSync(path, `${toHex(call.encodedData)}\n`)
		return path
	})
}

export function writeJson(dir: string, name: string, value: unknown): string {
	mkdirSync(dir, { recursive: true })
	const path = join(dir, name)
	// Not polkadot-api's `jsonSerialize`: it emits bigints as `"123n"`, but summary.json is read by
	// plain-JSON consumers (the post-test calls `BigInt(field)`), so bigints must stay bare digits.
	writeFileSync(
		path,
		`${JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`,
	)
	return path
}
