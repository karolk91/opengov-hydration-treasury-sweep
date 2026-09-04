# OpenGov Hydration treasury sweep

A small, fully typed [polkadot-api](https://papi.how) (PAPI) project that generates every OpenGov
call needed to submit a Polkadot referendum — on the **Root** or the **Whitelisted Caller** track —
whose enactment sweeps all USDT and USDC held on Hydration to the Polkadot Asset Hub treasury.

The proposal is a `Utility.batch_all` dispatched by Root on Asset Hub:

1. **Top-up** (optional, off by default): with `--top-up-dot <dot>`, an immediate
   `PolkadotXcm.send` to Hydration of a paid `Transact` (as `SovereignAccount`) that runs
   `Proxy.proxy(holder, Currencies.transfer(sovereign, DOT, amount))`, moving fee DOT from the
   holder to the sovereign account so it can pay for the sweep. Without it the proposal contains
   only the scheduler task and the sovereign account is expected to be funded out of band before
   enactment (see `--assume-sovereign-dot`).
2. **Periodic sweep**: one named `Scheduler.schedule_named_after` task (every ~1 h, `needed + extra` times) of a
   `PolkadotXcm.send` carrying a paid `Transact` that runs
   `Proxy.proxy(holder, None, XTokens.transfer_multicurrencies([(USDT, x), (USDC, y)], fee, treasury))`.
   All executions are equal (`floor(total / needed)` per asset, leaving
   fewer than `needed` raw units of dust) and sized so that one execution stays well below the
   circuit-breaker limit: by default the chunk is sized from the live limit so that our accumulator
   load peaks at 15 % (≈ 13 % per 6 h window; hourly executions). The `extra` executions (default 16) are a safety margin: if one is skipped
   because Hydration's egress bucket is full at that moment, a later one catches up; once the holder
   is empty the surplus executions fail inside the proxied call and nothing moves (only ~0.002 DOT
   of fee is spent). The task is named (`blake2_256` of a fixed label); the tool also prints and
   writes `Scheduler.cancel_named(id)` so that a later referendum (e.g. on the Whitelisted Caller
   track) can stop the sweep early if ever needed.

Each XCM is `WithdrawAsset(DOT) · BuyExecution · Transact · RefundSurplus · DepositAsset(sovereign)`,
Every leg is dry-run through the runtimes' `DryRunApi` (Asset Hub dispatch → Hydration execution → the reserve withdrawal Hydration sends to Asset Hub) before any referendum call is printed.

## Usage

Requires Node ≥ 22 — the `papi` codegen needs TypeScript 5.x, which is pinned.

```sh
npm install                 # also runs `papi` to generate the chain descriptors
npm start -- --balances-only            # just print balances, limits, fee estimate and the plan
npm start -- --track root               # generate everything for a Root referendum
npm start -- --track whitelisted-caller # ...or for the Whitelisted Caller track (+ Fellowship calls)
npm start -- --help
```

Useful options:

- `--max-footprint <share>` (default 0.15): derive the chunk from the *live* egress limit, capping
  the steady-state accumulator load at that share. The limit is denominated in HDX; re-run shortly
  before submitting.
- `--chunk <amount>`: explicit per-asset chunk, overrides the derivation.
- `--extra-executions <n>`: safety margin, default 16.
- `--interval-hours` (default 1): converted to scheduler blocks (Asset Hub's scheduler counts
  **relay-chain** blocks, ~6 s, read on-chain from `ParachainSystem.LastRelayChainBlockNumber`)
  and rounded to 100 blocks for reproducible calls.
- `--fee-budget-dot` (default 0.02): DOT withdrawn per message for Hydration execution; the surplus
  is refunded, so over-budgeting is free.
- `--top-up-dot <dot>`: optional top-up leg, default 0 = none.
- `--assume-sovereign-dot <dot>`: fee checks assume the sovereign account is pre-funded with this
  much DOT before enactment (out-of-band funding); the e2e verifies the funding against the fork.
- `--beneficiary <account>`: default is the Asset Hub treasury pot derived from `Treasury.PalletId`.
- `--usdt/--usdc <amount>`: override the swept totals.
- `--after/--at`: the enactment moment. `--skip-dry-run`: skip the `DryRunApi` verification.

The program prints, in order: the accounts involved, the holdings of the pure proxy and of the
sovereign account on Hydration, the proxy check, the amounts to sweep, Asset Hub context (treasury
balances, Hydration's reserve balances, fee pools, negotiated XCM version, measured scheduler clock), the
circuit-breaker state converted to USDT, the fee estimate from `XcmPaymentApi`, the sweep plan, the
decoded legs, the proposal, the dry-run report and finally the referendum calls
(`opengov-cli`-style: preimage, `Referenda.submit`, Fellowship calls on Collectives when
whitelisting, and one `Utility.force_batch` per chain). Call data is also written to `out/*.call`
plus `out/summary.json`.

## End-to-end testing with polkadot-referenda-tester

The referendum is exercised for real on Chopsticks forks by
[`polkadot-referenda-tester`](https://github.com/karolk91/polkadot-referenda-tester) (the
`feat/post-test-hook` branch, which adds a `--post-test` hook and per-endpoint Chopsticks db files):
this project prepares the calls, the tester forks Asset Hub + Hydration, creates and executes the
referendum, and then runs `post-tests/sweep.ts` against the live post-referendum network.

```sh
npm run test:e2e                  # enactment checks only: sweep task scheduled + sovereign funded
EXECUTIONS=2 npm run test:e2e     # also drive two sweeps and assert the treasury is credited
EXECUTIONS=all npm run test:e2e   # drive the whole schedule: drain, margin runs, schedule completion (~1 h)
```

Environment knobs (`scripts/e2e.sh`):

- `TRACK=root|whitelisted-caller`: the whitelisted track also forks Collectives and creates +
  executes the companion Fellowship referendum that whitelists the call.
- `EXECUTIONS=0|N|all`: how many scheduled sweeps the post-test drives.
- `PREFUND_SOVEREIGN_DOT=<dot>`: fund the sovereign account via a chopsticks `import-storage`
  override (written to `hydration-prefund.gen.yml`) instead of the on-chain top-up leg; generates
  with `--top-up-dot 0 --assume-sovereign-dot`. `FEE_BUDGET_DOT` sets the per-message budget.
- `SWEEP_USDT=<amt> SWEEP_USDC=<amt>`: reduced sweep: override the holder's balances in the fork so
  a full run empties the holder in a few executions (fast drain/margin/completion testing; requires prefund).
- `EXTRA_EXECUTIONS=<n>`, `GEN_EXTRA_ARGS="--flag …"`: forwarded to the generator.
- `USE_SUBWAY=0|1` (default 1): front the public endpoints with local
  [subway](https://github.com/AcalaNetwork/subway) proxies (caching + failover, `scripts/subway.sh`,
  ports 9011–9013); requires `cargo install --git https://github.com/AcalaNetwork/subway --locked`,
  falls back to direct endpoints when the binary is missing.
- `AH_WS` / `HYDRATION_WS` / `RELAY_WS` / `COLLECTIVES_WS`: endpoint overrides. The relay is forked
  alongside so chopsticks routes the AH↔Hydration sibling HRMP.

The post-test (`post-tests/sweep.ts`, loaded by the tester's `--post-test` hook) asserts against
the post-referendum network:

1. **Enactment**: the named periodic sweep task is scheduled with the right interval and count, and
   the sovereign account holds the fee DOT (from the top-up XCM, or from the out-of-band prefund).
2. **Driving** (`EXECUTIONS>0`): each execution is dispatched (`Scheduler.Dispatched` success
   asserted), relocated forward and fired; Hydration is advanced one interval per execution with a
   slot-consistent time travel (relay `CurrentSlot` override + relay-parent bump), so the egress
   breaker decays as in production; each sweep must credit the Asset Hub treasury, drain the holder
   by the same amount (within fees), keep the proxied `XTokens` transfer succeeding, and keep the
   breaker under the cap. Blocks are built through the live chopsticks `Blockchain` objects the
   tester hands over (in-process `connectParachains` HRMP delivery); every chopsticks operation has
   a 300 s ceiling.
3. **Completion** (full run): once the holder is drained, the remaining margin executions are fired
   and each must be delivered to Hydration and *rejected* (holder empty, no funds moved); the run
   ends with the named task gone from `Scheduler.Lookup` — the schedule-complete signal (a periodic
   task has no completion event).

Requires a Node that can import `.ts` (>= 22.18 / 23.6, or the tester's pinned Node 24), and the
tester checked out next to this repo (override with `PRT_DIR=...`).

### GitHub Actions

`.github/workflows/e2e.yml` runs the same e2e on demand (`workflow_dispatch`) with inputs for the
track, executions, prefund, fee budget, reduced sweep, extra generator flags, subway, and the tester
ref. The job summary prints the plan, the exact generated calls (`out/*.call`), and the post-test
results; the full log and `out/` are uploaded as artifacts.

## Development

```sh
npm run typecheck   # tsc --noEmit (strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess)
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

- Amounts are read at generation time; re-run the tool right before submitting to pick up any
  change.
- Hydration's egress limit is global (shared with all users) and denominated in HDX. If a scheduled
  execution does not fit the headroom at that moment it simply fails on Hydration (nothing moves,
  ~0.002 DOT of fee is spent) and one of the extra executions catches up later; if more executions
  fail than the margin covers, whatever is left can be swept with a follow-up run of this tool.
- The `Transact`s are paid from the sovereign account's DOT (funded out of band, or via the
  optional `--top-up-dot` leg); generation stops with an error if the estimated fees are not
  covered.
