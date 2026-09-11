import type { SizedHex, SS58String, TxCallData } from "polkadot-api"
import type { OfflineApis } from "./chains.ts"
import { SCHEDULER_TASK_LABEL } from "./config.ts"
import { buildTopUpCall, buildTransferChunkCall, type EncodedCall } from "./hydrationCall.ts"
import type { ChunkPlan } from "./plan.ts"
import { callHash } from "./referendum.ts"
import { buildSendToHydration, buildTransactXcm, type Weight } from "./xcm.ts"

export interface SweepParams {
	readonly holder: SS58String

	readonly sovereign: { readonly ss58: SS58String; readonly publicKey: Uint8Array }

	readonly beneficiary: Uint8Array
	readonly plan: ChunkPlan

	readonly feeBudget: bigint

	readonly topUp: { readonly dotAssetId: number; readonly amount: bigint } | undefined

	readonly priority: number
	readonly fallbackMaxWeight: Weight | undefined
}

export interface XcmLeg {
	readonly title: string

	readonly hydrationCall: EncodedCall

	readonly instructions: ReturnType<typeof buildTransactXcm>

	readonly send: EncodedCall
}

export interface Proposal {
	readonly call: EncodedCall
	readonly topUp: XcmLeg | undefined
	readonly periodic: XcmLeg & {
		readonly count: number
		readonly firstAfter: number
		readonly every: number

		readonly taskId: SizedHex<32>
	}

	readonly cancel: EncodedCall
}

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
				(asset, position) => [asset.hydrationAssetId, plan.perExecution[position] ?? 0n] as const,
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
