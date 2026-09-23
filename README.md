# OpenGov Hydration treasury sweep

Generates the OpenGov calls for Polkadot referenda that move USDT and USDC from Hydration pure-proxy
accounts to the Polkadot Asset Hub treasury, and dry-runs them on Chopsticks forks through
[`polkadot-referenda-tester`](https://github.com/karolk91/polkadot-referenda-tester).

Two generators:

- `npm start` builds a referendum that sweeps one holder in equal periodic chunks.
- `npm run consolidation` builds a referendum that redirects the four legacy sweep schedules to the
  current treasury.

Both use [polkadot-api](https://papi.how) with generated descriptors.

## Single-holder sweep (`npm start`)

The proposal is a `Utility.batch_all` dispatched by Root on Asset Hub:

1. **Top-up** (optional, off by default): with `--top-up-dot <dot>`, an immediate
   `PolkadotXcm.send` to Hydration of a paid `Transact` (as `SovereignAccount`) that runs
   `Proxy.proxy(holder, Currencies.transfer(sovereign, DOT, amount))`. It moves fee DOT from the
   holder to the sovereign account. Without it, the sovereign account must be funded before
   enactment (see `--assume-sovereign-dot`).
2. **Periodic sweep**: one `Scheduler.schedule_named_after` task (every ~1 h, `needed + extra`
   times) of a `PolkadotXcm.send` carrying a paid `Transact` that runs
   `Proxy.proxy(holder, None, XTokens.transfer_multicurrencies([(USDT, x), (USDC, y)], fee, treasury))`.
   Every execution moves the same amount (`floor(total / needed)` per asset, leaving fewer than
   `needed` raw units of dust). The chunk is sized from the live circuit-breaker limit so that the
   accumulator load peaks at 15% by default. The `extra` executions (default 16) are a margin: an
   execution that does not fit Hydration's egress headroom fails and a later one moves the amount
   instead; once the holder is empty the surplus executions fail inside the proxied call and move
   nothing (~0.002 DOT of fee each). The task id is `blake2_256` of a fixed label; the tool also
   writes `Scheduler.cancel_named(id)` so a later referendum can stop the sweep.

Each XCM is `WithdrawAsset(DOT) · BuyExecution · Transact · RefundSurplus · DepositAsset(sovereign)`.
Every leg is dry-run through the runtimes' `DryRunApi` (Asset Hub dispatch, Hydration execution, the
reserve withdrawal Hydration sends back to Asset Hub) before any referendum call is written.

### Usage

Requires Node >= 22. The `papi` codegen needs TypeScript 5.x, which is pinned.

```sh
npm install                             # also runs `papi` to generate the chain descriptors
npm start -- --balances-only            # print balances, limits, fee estimate and the plan
npm start -- --track root               # generate everything for a Root referendum
npm start -- --track whitelisted-caller # Whitelisted Caller track (+ Fellowship calls)
npm start -- --help
```

Options:

- `--max-footprint <share>` (default 0.15): derive the chunk from the live egress limit so the
  steady-state accumulator load stays at or below that share. The limit is denominated in HDX;
  re-run shortly before submitting.
- `--chunk <amount>`: explicit per-asset chunk, overrides the derivation.
- `--extra-executions <n>`: margin executions, default 16.
- `--interval-hours` (default 1): converted to scheduler blocks (Asset Hub's scheduler counts
  relay-chain blocks, ~6 s, read on-chain from `ParachainSystem.LastRelayChainBlockNumber`) and
  rounded to 100 blocks for reproducible calls.
- `--fee-budget-dot` (default 0.02): DOT withdrawn per message for Hydration execution; the
  surplus is refunded, so over-budgeting costs nothing.
- `--top-up-dot <dot>`: optional top-up leg, default 0 = none.
- `--assume-sovereign-dot <dot>`: fee checks assume the sovereign account has this much DOT before
  enactment (out-of-band funding); the e2e verifies the funding against the fork.
- `--beneficiary <account>`: default is the Asset Hub treasury pot derived from `Treasury.PalletId`.
- `--usdt/--usdc <amount>`: override the swept totals.
- `--after/--at`: the enactment moment. `--skip-dry-run`: skip the `DryRunApi` verification.

The program prints the accounts, the holder's and the sovereign account's balances on Hydration,
the proxy check, the amounts, Asset Hub context (treasury balances, Hydration's reserve balances,
fee pools, negotiated XCM version, measured scheduler clock), the circuit-breaker state converted to
USDT, the fee estimate from `XcmPaymentApi`, the sweep plan, the decoded legs, the proposal, the
dry-run report and the referendum calls (`opengov-cli` style: preimage, `Referenda.submit`,
Fellowship calls on Collectives when whitelisting, and one `Utility.force_batch` per chain). Call
data is written to `out/*.call` plus `out/summary.json`.

## Consolidation referendum (`npm run consolidation`)

Four legacy OpenGov schedules on the Asset Hub scheduler sweep four Hydration pure proxies to the
old treasury account; three of them fail on every firing because the Asset Hub sovereign is not a
proxy delegate of their holder. `src/consolidation.ts` decodes the four live schedules from the
agenda and builds one Root `Utility.batch_all` that:

1. removes the four legacy tasks' preimages with `Preimage.unnote_preimage(hash)`. The tasks are
   unnamed periodic `Lookup` tasks whose agenda slots drift (the scheduler re-places a task from the
   relay block that serviced it, and Asset Hub skips relay blocks), so `Scheduler.cancel(when, index)`
   cannot target them reliably weeks ahead. Without its preimage a task emits
   `Scheduler.CallUnavailable` at its next occurrence, dispatches nothing, and is not re-scheduled;
2. adds the Asset Hub sovereign as an `Any` proxy delegate on the holders that lack it: one
   relay-routed XCM with one `Transact` per holder, authorized by each holder's existing `Parent`
   delegate;
3. schedules fresh sweeps to the current treasury (`schedule_named_after`, first firing 600 relay
   blocks after enactment so the proxy has propagated): a chunked sweep at ~15% of the egress limit
   for the large holder, a single-shot for the near-drained holders, and only the post-stall
   leftover (`balance mod 5000`) for the holder whose legacy schedule still works.

```sh
npm run consolidation -- --enact-at-block 33396685           # enact At(B): real submission
npm run consolidation -- --enact-offset 100000               # dry-run: B = latest legacy slot + N
npm run consolidation -- --track whitelisted-caller ...      # also writes the Fellowship calls
npm run consolidation -- --reduce-chunked 50000 ...          # also writes out/hyd-reduce.yml
```

Flags:

- `--enact-at-block <B>`: relay block of the enactment (`At(B)`). `--cancel-at-block` is an alias.
- `--enact-offset <N>`: `B = latest legacy slot + N`. For dry-runs.
- `--track root|whitelisted-caller` (default root).
- `--reduce-chunked <amount>`: write a Hydration Chopsticks override that caps the chunked holder at
  this 6-decimal amount, so a full-drain dry-run finishes in a few executions.

Outputs: `out/all-preimage.call`, `out/all-submit.call`, `out/summary-all.json` (tasks, legacy
preimage hashes and slots, quoted fees), `out/all-fellowship-submit.call` (+ `-preimage` when
needed) for the whitelisted track, `out/hyd-reduce.yml` with `--reduce-chunked`.

Enactment timing: Referenda enacts at `max(B, approval_block + min_enactment_period)`. The batch
does not depend on the enactment block; B only sets when the new sweeps start. For the #1501
holder the new sweep moves `balance mod 5000`, which is correct for any B after its legacy schedule
has moved the last full 5,000 (see `.agent/tools/legacy-1501-finish.ts`).

## End-to-end testing with polkadot-referenda-tester

The tester (`feat/post-test-hook` branch, which adds a `--post-test` hook and per-endpoint
Chopsticks db files) forks Asset Hub, Hydration and the relay, creates and executes the referendum,
then runs a post-test against the live forks. Both scripts front the public RPC endpoints with
local [subway](https://github.com/AcalaNetwork/subway) proxies by default (`USE_SUBWAY=0` to
disable; requires `cargo install --git https://github.com/AcalaNetwork/subway --locked`; without
the binary the scripts use the public endpoints directly). Requires a Node that imports `.ts`
(>= 22.18 / 23.6, or the tester's pinned Node 24) and the tester checked out next to this repo
(override with `PRT_DIR=...`).

### Single-holder sweep: `scripts/e2e.sh`

```sh
npm run test:e2e                  # enactment checks only: sweep task scheduled + sovereign funded
EXECUTIONS=2 npm run test:e2e     # also drive two sweeps and assert the treasury is credited
EXECUTIONS=all npm run test:e2e   # drive the whole schedule: drain, margin runs, schedule completion
```

Environment variables:

- `TRACK=root|whitelisted-caller`: the whitelisted track also forks Collectives and creates and
  executes the Fellowship referendum that whitelists the call.
- `EXECUTIONS=0|N|all`: how many scheduled sweeps the post-test drives.
- `PREFUND_SOVEREIGN_DOT=<dot>`: fund the sovereign account via a Chopsticks `import-storage`
  override (`hydration-prefund.gen.yml`) instead of the on-chain top-up leg; generates with
  `--top-up-dot 0 --assume-sovereign-dot`. `FEE_BUDGET_DOT` sets the per-message budget.
- `SWEEP_USDT=<amt> SWEEP_USDC=<amt>`: override the holder's balances in the fork so a full run
  drains in a few executions (requires prefund).
- `EXTRA_EXECUTIONS=<n>`, `GEN_EXTRA_ARGS="--flag ..."`: forwarded to the generator.
- `BLOCK_DETAILS=0|1` (default 1): print every built block on both forks with its events.
- `AH_WS` / `HYDRATION_WS` / `RELAY_WS` / `COLLECTIVES_WS`: endpoint overrides.

`post-tests/sweep.ts` asserts: the periodic sweep task is scheduled with the right interval and
count and the sovereign account has the fee DOT; with `EXECUTIONS>0`, each execution is dispatched
(`Scheduler.Dispatched` success), Hydration is advanced one interval with a slot-consistent time
travel so the egress breaker decays as in production, and each sweep credits the treasury, drains
the holder by the same amount (within fees), and stays under the breaker cap; on a full run the
remaining margin executions are delivered and rejected (holder empty) and the task leaves
`Scheduler.Lookup`.

### Consolidation: `scripts/e2e-all.sh`

```sh
bash scripts/e2e-all.sh                                # once: fire each new sweep one time
EXECUTIONS=2 bash scripts/e2e-all.sh                   # fire the chunked sweep twice
EXECUTIONS=all REDUCE_CHUNKED_TO=50000 bash scripts/e2e-all.sh   # drain the chunked sweep
TRACK=whitelisted-caller bash scripts/e2e-all.sh
```

Environment variables: `TRACK`, `EXECUTIONS=once|N|all` (a number N fires the chunked sweep N
times; single-shot sweeps fire once regardless), `ENACT_BLOCK` (real B; empty uses
`ENACT_OFFSET`, default 100000), `REDUCE_CHUNKED_TO`, `BLOCK_DETAILS`, `USE_SUBWAY`, and the
endpoint overrides above.

`post-tests/all.ts` asserts: the Asset Hub sovereign is a delegate on every holder that lacked it,
all four legacy tasks are gone from the agenda, all four new tasks are present, each new sweep
drains its holder and credits the current treasury, single-shot tasks leave the scheduler after
firing, and with `EXECUTIONS=all` the chunked holder ends below one chunk.

### GitHub Actions

`.github/workflows/e2e.yml` runs the consolidation dry-run on demand (`workflow_dispatch`).
Inputs: `track`, `executions` (`once`, a number, or `all`), `enact_block`, `reduce_chunked_to`,
`block_details`, `use_subway`, `prt_ref`. The job summary prints the decoded schedules, the exact
generated calls and the post-test results; the full log and `out/` are uploaded as artifacts.

## Development

```sh
npm run typecheck   # tsc --noEmit over src/ and post-tests/
npm run lint        # biome check
npm test            # node:test via tsx
npm run check       # all of the above
npm run papi:update # refresh .papi/metadata/*.scale after runtime upgrades, then re-run the tests
npm run breaker-history -- --days 14 --step-minutes 30   # utilisation history of Hydration's egress limit
```

`.papi/metadata/*.scale` and `.papi/polkadot-api.json` are committed; `.papi/descriptors` is
regenerated on `npm install`. `tsconfig.json` uses `moduleResolution: bundler`, which the generated
descriptors require.

## Caveats

- Amounts are read at generation time; re-run the tool right before submitting.
- Hydration's egress limit is global and denominated in HDX. A scheduled execution that does not
  fit the headroom fails on Hydration (nothing moves, ~0.002 DOT of fee) and a later margin
  execution moves the amount; if more executions fail than the margin covers, a follow-up run of
  the tool sweeps the remainder.
- The `Transact`s are paid from the sovereign account's DOT (funded out of band, or via the
  optional `--top-up-dot` leg); generation stops with an error if the estimated fees are not
  covered.
