import { parseArgs } from "node:util"
import { TraitsScheduleDispatchTime } from "@polkadot-api/descriptors"
import { DEFAULT_ENDPOINTS, DEFAULT_HOLDER, DEFAULTS } from "./config.ts"
import type { Track } from "./referendum.ts"

export interface Options {
	readonly track: Track
	readonly enactment: TraitsScheduleDispatchTime
	readonly holder: string
	readonly beneficiary: string | undefined
	readonly usdtAmount: string | undefined
	readonly usdcAmount: string | undefined
	readonly chunk: string | undefined
	readonly maxFootprint: number
	readonly intervalHours: number
	readonly extraExecutions: number
	readonly feeBudgetDot: string
	readonly topUpDot: string
	readonly assumeSovereignDot: string | undefined
	readonly skipDryRun: boolean
	readonly balancesOnly: boolean
	readonly outDir: string
	readonly lengthLimit: number
	readonly assetHubEndpoints: readonly string[]
	readonly hydrationEndpoints: readonly string[]
}

export const HELP = `Generate the OpenGov calls for a Polkadot referendum that sweeps all USDT and USDC on
Hydration from a pure proxy to the Polkadot Asset Hub treasury.

Usage: npm start -- [options]

Referendum:
  --track <root|whitelisted-caller>  Track of the public referendum (default: root)
  --after <blocks>                   Enact <blocks> after approval (default: 10)
  --at <block>                       Enact at a specific Asset Hub block number

Sweep:
  --holder <account>                 Hydration account with the funds (default: ${DEFAULT_HOLDER})
  --beneficiary <account>            Destination on Asset Hub (SS58 or 0x hex). Default: treasury pot
  --usdt <amount>                    Sweep this USDT total instead of the current balance
  --usdc <amount>                    Sweep this USDC total instead of the current balance
  --max-footprint <share>            Max share of Hydration's egress limit our sweep may occupy (default: ${DEFAULTS.maxFootprintShare})
  --chunk <amount>                   Max amount per asset per execution (default: derived from --max-footprint)
  --interval-hours <hours>           Time between executions (default: ${DEFAULTS.intervalHours})
  --extra-executions <n>             Extra executions scheduled as a safety margin (default: ${DEFAULTS.extraExecutions})
  --fee-budget-dot <amount>          DOT withdrawn per execution for Hydration fees (default: ${DEFAULTS.feeBudgetDot})
  --top-up-dot <amount>              Optional top-up leg: DOT moved holder -> sovereign account up front (default: ${DEFAULTS.topUpDot} = none)
  --assume-sovereign-dot <amount>    Assume the sovereign is pre-funded with this much DOT before enactment
                                     (for fee checks); pair with --top-up-dot 0 to drop the on-chain top-up

Output:
  --balances-only                    Only print balances and limits, do not build any call
  --skip-dry-run                     Do not dry-run the calls through the chains' DryRunApi
  --out-dir <dir>                    Where to write the .call files (default: out)
  --length-limit <bytes>             Do not print call data longer than this (default: 1000)
  --asset-hub-ws <url>               Asset Hub RPC endpoint (repeatable)
  --hydration-ws <url>               Hydration RPC endpoint (repeatable)
  -h, --help                         Show this help
`

function parseTrack(value: string): Track {
	switch (value.toLowerCase()) {
		case "root":
			return "root"
		case "whitelisted-caller":
		case "whitelistedcaller":
		case "whitelisted":
			return "whitelisted-caller"
		default:
			throw new Error(`Unsupported track "${value}". Use "root" or "whitelisted-caller".`)
	}
}

function parseNonNegativeInt(value: string, flag: string): number {
	const valueAsNumber = Number(value)
	if (!Number.isInteger(valueAsNumber) || valueAsNumber < 0) {
		throw new Error(`${flag} expects a non-negative integer, got "${value}"`)
	}
	return valueAsNumber
}

function parseShare(value: string, flag: string): number {
	const valueAsNumber = Number(value)
	if (!Number.isFinite(valueAsNumber) || valueAsNumber <= 0 || valueAsNumber > 1) {
		throw new Error(`${flag} expects a share between 0 and 1, got "${value}"`)
	}
	return valueAsNumber
}

function parsePositiveNumber(value: string, flag: string): number {
	const valueAsNumber = Number(value)
	if (!Number.isFinite(valueAsNumber) || valueAsNumber <= 0) {
		throw new Error(`${flag} expects a positive number, got "${value}"`)
	}
	return valueAsNumber
}

export function parseOptions(argv: readonly string[]): Options | "help" {
	const { values } = parseArgs({
		args: [...argv],
		options: {
			track: { type: "string", default: "root" },
			after: { type: "string" },
			at: { type: "string" },
			holder: { type: "string", default: DEFAULT_HOLDER },
			beneficiary: { type: "string" },
			usdt: { type: "string" },
			usdc: { type: "string" },
			chunk: { type: "string" },
			"max-footprint": { type: "string", default: String(DEFAULTS.maxFootprintShare) },
			"interval-hours": { type: "string", default: String(DEFAULTS.intervalHours) },
			"extra-executions": { type: "string", default: String(DEFAULTS.extraExecutions) },
			"fee-budget-dot": { type: "string", default: DEFAULTS.feeBudgetDot },
			"top-up-dot": { type: "string", default: DEFAULTS.topUpDot },
			"assume-sovereign-dot": { type: "string" },
			"skip-dry-run": { type: "boolean", default: false },
			"balances-only": { type: "boolean", default: false },
			"out-dir": { type: "string", default: "out" },
			"length-limit": { type: "string", default: "1000" },
			"asset-hub-ws": { type: "string", multiple: true },
			"hydration-ws": { type: "string", multiple: true },
			help: { type: "boolean", short: "h", default: false },
		},
		strict: true,
	})
	if (values.help) return "help"
	if (values.after !== undefined && values.at !== undefined) {
		throw new Error("Use only one of --after and --at")
	}
	const enactment =
		values.at !== undefined
			? TraitsScheduleDispatchTime.At(parseNonNegativeInt(values.at, "--at"))
			: TraitsScheduleDispatchTime.After(parseNonNegativeInt(values.after ?? "10", "--after"))
	return {
		track: parseTrack(values.track),
		enactment,
		holder: values.holder,
		beneficiary: values.beneficiary,
		usdtAmount: values.usdt,
		usdcAmount: values.usdc,
		chunk: values.chunk,
		maxFootprint: parseShare(values["max-footprint"], "--max-footprint"),
		intervalHours: parsePositiveNumber(values["interval-hours"], "--interval-hours"),
		extraExecutions: parseNonNegativeInt(values["extra-executions"], "--extra-executions"),
		feeBudgetDot: values["fee-budget-dot"],
		topUpDot: values["top-up-dot"],
		assumeSovereignDot: values["assume-sovereign-dot"],
		skipDryRun: values["skip-dry-run"],
		balancesOnly: values["balances-only"],
		outDir: values["out-dir"],
		lengthLimit: parseNonNegativeInt(values["length-limit"], "--length-limit"),
		assetHubEndpoints: values["asset-hub-ws"] ?? DEFAULT_ENDPOINTS.assetHub,
		hydrationEndpoints: values["hydration-ws"] ?? DEFAULT_ENDPOINTS.hydration,
	}
}
