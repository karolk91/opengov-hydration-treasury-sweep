import type { SizedHex, SS58String, TxCallData } from "polkadot-api"
import type { OfflineApis } from "./chains.ts"
import { SCHEDULER_TASK_LABEL } from "./config.ts"
import { buildTopUpCall, buildTransferChunkCall, type EncodedCall } from "./hydrationCall.ts"
import type { ChunkPlan } from "./plan.ts"
import { callHash } from "./referendum.ts"
import { buildSendToHydration, buildTransactXcm, type Weight } from "./xcm.ts"

export interface SweepParams {
	/** Account on Hydration holding the stablecoins (the pure proxy). */
	readonly holder: SS58String
	/** Asset Hub's sovereign account on Hydration: proxy delegate, fee payer and refund target. */
	readonly sovereign: { readonly ss58: SS58String; readonly publicKey: Uint8Array }
	/** Account on Asset Hub receiving the stablecoins. */
	readonly beneficiary: Uint8Array
	readonly plan: ChunkPlan
	/** DOT withdrawn from the sovereign account for each XCM execution on Hydration. */
	readonly feeBudget: bigint
	/** Optional one-time DOT transfer from the holder to the sovereign account, before the sweep. */
	readonly topUp: { readonly dotAssetId: number; readonly amount: bigint } | undefined
	/** Scheduler priority of the sweep executions (0 = hard deadline). */
	readonly priority: number
	readonly fallbackMaxWeight: Weight | undefined
}

export interface XcmLeg {
	readonly title: string
	/** Hydration call dispatched by the `Transact`. */
	readonly hydrationCall: EncodedCall
	/** The XCM program executed on Hydration. */
	readonly instructions: ReturnType<typeof buildTransactXcm>
	/** `PolkadotXcm.send` on Asset Hub carrying the program. */
	readonly send: EncodedCall
}

export interface Proposal {
	readonly call: EncodedCall
	readonly topUp: XcmLeg | undefined
	readonly periodic: XcmLeg & {
		/** Scheduled executions (needed + margin). */
		readonly count: number
		readonly firstAfter: number
		readonly every: number
		/** Name of the scheduler task, so governance can `Scheduler.cancel_named` it. */
		readonly taskId: SizedHex<32>
	}
	/** `Scheduler.cancel_named(taskId)`: the one-line call that stops the sweep early. */
	readonly cancel: EncodedCall
}

/** Deterministic scheduler task name: `blake2_256(label)`. */
export function schedulerTaskId(label: string = SCHEDULER_TASK_LABEL): SizedHex<32> {
	return callHash(new TextEncoder().encode(label))
}

function transactLeg(
	apis: OfflineApis,
	params: SweepParams,
	title: string,
	hydrationCall: EncodedCall,
): XcmLeg {
	const instructions = buildTransactXcm({
		feeBudget: params.feeBudget,
		call: hydrationCall.encodedData,
		fallbackMaxWeight: params.fallbackMaxWeight,
		refundTo: params.sovereign.publicKey,
	})
	return {
		title,
		hydrationCall,
		instructions,
		send: buildSendToHydration(apis.assetHub, instructions),
	}
}

/**
 * The privileged call the referendum dispatches on Asset Hub, a `Utility.batch_all` of:
 *
 * 1. optionally, an immediate XCM that moves some of the holder's DOT to Asset Hub's sovereign
 *    account on Hydration (it pays for every later execution);
 * 2. one named periodic scheduler task sending the sweep XCM `needed + extra` times, every
 *    `intervalBlocks` relay-chain blocks, starting one interval after enactment.
 *
 * Every XCM is a paid `Transact` executed as the sovereign account, which is an `Any` proxy of the
 * holder, so the stablecoins leave the holder through `XTokens.transfer_multicurrencies`.
 * Equal chunks keep each execution well under Hydration's
 * global XCM egress limit; the `extra` executions catch up on any that were skipped and fail
 * harmlessly (inside the proxied call, nothing moves) once the holder is empty. The task is named
 * so that a later referendum can stop it with `Scheduler.cancel_named`.
 */
export function buildProposal(apis: OfflineApis, params: SweepParams): Proposal {
	const { plan } = params
	const calls: TxCallData[] = []

	let topUp: XcmLeg | undefined
	if (params.topUp) {
		topUp = transactLeg(
			apis,
			params,
			"Top up the sovereign account with DOT for fees",
			buildTopUpCall(
				apis.hydration,
				params.holder,
				params.sovereign.ss58,
				params.topUp.dotAssetId,
				params.topUp.amount,
			),
		)
		calls.push(topUp.send.decodedCall)
	}

	const leg = transactLeg(
		apis,
		params,
		"Sweep execution",
		buildTransferChunkCall(apis.hydration, params.holder, {
			currencies: plan.assets.map(
				(asset, i) => [asset.hydrationAssetId, plan.perExecution[i] ?? 0n] as const,
			),
			beneficiary: params.beneficiary,
		}),
	)
	const every = plan.intervalBlocks
	const taskId = schedulerTaskId()
	calls.push(
		apis.assetHub.tx.Scheduler.schedule_named_after({
			id: taskId,
			after: every,
			maybe_periodic: plan.scheduled > 1 ? [every, plan.scheduled] : undefined,
			priority: params.priority,
			call: leg.send.decodedCall,
		}).decodedCall,
	)

	return {
		call: apis.assetHub.tx.Utility.batch_all({ calls }),
		topUp,
		periodic: { ...leg, count: plan.scheduled, firstAfter: every, every, taskId },
		cancel: apis.assetHub.tx.Scheduler.cancel_named({ id: taskId }),
	}
}
