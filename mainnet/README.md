# Hydration Gamma ALM production handoff

This directory deploys the Gamma vault over the **already-live** aDOT/HOLLAR
Uniswap v3 pool, wires the Model B access split, and hands every owner role to
governance. It never submits governance transactions, and it does not seed
liquidity — seeding is a separate, later referendum whose preimage this
directory prints.

It is the phase-2 companion to `uniswap-v3-deploy/mainnet`, which must have run
first. Same shape, same gas rules, same asset-resolution rules.

| Phase | Command | Result |
| --- | --- | --- |
| Validate | `npm run preflight` | Read-only gate over target, roles, pool, guards and seed |
| Deploy | `npm run deploy` | Gamma stack, wired, still owned by the deploy key |
| Hand over | `npm run handover` | Launch band, UniProxy deposits, every role to governance |
| Verify | `npm run verify` | Read-only post-handover verification |
| Seed | `npm run governance -- seed` | Prints, but does not submit, the treasury seed proposal |

## Operator runbook

```bash
cd gamma-hypervisor
npm install --legacy-peer-deps && npx hardhat compile

cd mainnet
npm ci
cp .env.example .env.mainnet
# Fill DEPLOYER_PK, KEEPER_ADDRESS, FEE_RECIPIENT, V3_FACTORY, V3_POOL,
# the caps and the seed. Review every value.

ENV_FILE=.env.mainnet npm run all
```

### Fix the pool price BEFORE the handover

`03-handover.js` centres the launch band on the pool's **current** tick, and it
refuses to run when that tick is more than `ANCHOR_MAX_DEV_TICKS` (200, ~2%)
from `PRICE_FEED_A`. Step 3 is read-only — it never moves a price itself.

An empty pool's price is frozen at whatever `initialize()` set: with no
liquidity there is no arbitrage to drag it back, so the gap only widens. Placing
a band on a stale price is unrecoverable in practice — `RebalanceProxy.customDiff`
caps the keeper at 500 ticks, so after step 8 correcting it takes a referendum —
and the first real liquidity is arbitraged for the whole gap (~320 bps at a 10%
gap).

Correcting it is **`11-anchor-price.js`**, a separate one-off:

```bash
cp .env.anchor.example .env.anchor    # fill ANCHOR_PK
ENV_FILE=.env.anchor node 11-anchor-price.js --dry-run
ENV_FILE=.env.anchor node 11-anchor-price.js
```

It mints a tiny position, swaps once with `sqrtPriceLimitX96` set to the feed
price, and burns the position. Both tokens come back; the cost is gas.

Deliberately not part of the handover, for two reasons: it needs token inventory
the deploy key does not have (so whoever holds a little aDOT and HOLLAR can run
it — Ben, not the launch operator), and a script that hands over ownership
should not also move a market price as a side effect.

**Why not "just swap through SwapRouter02".** It reverts. Uniswap's router
callback opens with `require(amount0Delta > 0 || amount1Delta > 0)` —
*"swaps entirely within 0-liquidity regions are not supported"* — and an empty
pool's deltas are both zero. `pool.swap()` from an EOA fails too: the pool calls
back into `msg.sender`, and an EOA has no code. Minting the sliver of liquidity
first is what makes the deltas non-zero and satisfies the router; the swap then
rides free through the empty ticks to the limit.

**After anchoring, deposits are blocked for ~50-60 min.** Spot has jumped away
from the pool's hourly average and ClearingV2 rejects deposits until they
reconverge. The handover is unaffected and can run immediately — it prints
whether deposits would clear yet. Only the first *deposit* has to wait.

`npm run all` stops with the vault live, empty and capped. Then:

1. **Start the keeper** (`../keeper`, `ENTRYPOINT=proxy`). It keeps the band
   centred on the tick, and ClearingV2 rejects any deposit taken while the tick
   sits outside that band — so a vault left unmanaged between handover and seed
   can drift itself out of accepting its own seed.
2. `ENV_FILE=.env.mainnet npm run governance -- seed` and submit that exact
   preimage on **track 5 (`treasurer`)** — see *Governance origin* below.
3. After enactment:

```bash
ENV_FILE=.env.mainnet npm run verify
ENV_FILE=.env.mainnet npm run verify -- events <first-enactment-block> <count>
```

The `events` scan exists because `dispatcher.dispatchAsTreasury` returns `{Ok}`
at the outer level even when the inner `evm.call` reverted, and
`utility.BatchCompleted` fires regardless — that combination bricked
money-market referendum 322. Treat a clean extrinsic result as meaningless; only
the event scan and the state verifier are evidence.

## Governance origin

**Each call goes on the narrowest track that satisfies its origin.** Nothing in
this launch needs Root, so nothing asks for it.

| Command | Dispatches as | Track |
| --- | --- | --- |
| `seed`, `pull` | `dispatchAsTreasury` | **5** (`treasurer`) |
| `caps`, `fee`, `pause`, `recenter` | `dispatchAsAaveManager` | **9** (`economic_parameters`) |

That is two referenda, not one. `GOVERNANCE_TRACK=root` collapses them onto
track 0 if the team would rather run a single one — the call bytes are
identical either way, only the submission track moves.

Three dispatch identities exist and they are not interchangeable
(`runtime/hydradx/src/governance/mod.rs:301-302`, `:321-323`):

| Dispatcher call | Acts as | Origin | Narrowest track |
| --- | --- | --- | --- |
| `dispatchAsTreasury` | `0x6d6f646c70792f7472737279…` | `Root \| Treasurer` | 5 |
| `dispatchAsAaveManager` | `0xaa7e…aa7e0` | `Root \| EconomicParameters` | 9 |
| `dispatchAsEmergencyAdmin` | `0xaa7e…**aa7e1**` | `Root \| TechCommitteeMajority` | TC motion |

Both origins this directory uses are `EitherOf<EnsureRoot<_>, …>`, so Root
would dispatch either — it is an option, never a requirement.

What Root would cost, from `governance/tracks.rs`. Prepare (1h), decision
(**7d**), confirm (12h) and `min_approval` (`APP_RECIP`) are **identical**
across tracks 0, 5 and 9 — Root is not slower. It is dearer and needs more
turnout:

```text
                  decision deposit      min_support
  root (0)         1,000,000 HDX        SUP_LINEAR       -> 36%
  treasurer (5)      750,000 HDX        SUP_FAST_LINEAR  -> 18%
  economic_par (9)   750,000 HDX        SUP_FAST_LINEAR  -> 18%
```

Each proposal prints the track it is being submitted on, and flags the
escalation whenever `GOVERNANCE_TRACK` puts it above its minimum.
`GOVERNANCE_TRACK=<name|id>` pins one explicitly.

**ClearingV2 sits with the Technical Committee on mainnet.** The handover set
`CLEARING_OWNER` to `0xaa7e…aa7e1`, which the TC reaches via
`dispatchAsEmergencyAdmin`, so ClearingV2's levers (`pause`, `customDeposit`, …)
are TC motions or Root, not track-9 referenda. `caps` and `pause` above still
dispatch as `0xaa7e…aa7e0` and would enact `Ok` while changing nothing; the cap
has its own script, below. The emergency `pullLiquidity` runbook goes through
Admin, which stays with `0xaa7e…aa7e0`: a 7-day referendum. That half of the
economics study's P5 caveat stands.

## Raising the share cap (Technical Committee)

`12-tc-caps.js` prints the motion that sets a new `maxTotalSupply`. It needs
nothing from the launch operator: the mainnet addresses are pre-filled in
`.env.tc-caps.example` and checked on chain before use.

```bash
cp .env.tc-caps.example .env.tc-caps
ENV_FILE=.env.tc-caps node 12-tc-caps.js 250000     # the new cap, in shares
```

The cap is a share count, not USD (see *Things that will bite*); the script
prints what the new cap is worth at today's value per share. Only
`maxTotalSupply` changes: the per-deposit limits and `customDepositDelta` are
read from the chain and passed back as they are.

Before building anything it refuses an owner other than `0xaa7e…aa7e1`, a vault
ClearingV2 does not know, a zero `customDepositDelta` with the override on, the
cap already in place, a cap at or below the shares that exist (that blocks
every deposit; `pause` is the tool for that), too little gas on
`0xaa7e…aa7e1`, and a `customDeposit` that reverts when dry-run as it.

What it prints, and what happens next:

1. **The proposal**: `dispatcher.dispatchAsEmergencyAdmin(evm.call(customDeposit))`,
   its hash, and the length and weight bounds `close` needs.
2. **The motion**: `technicalCommittee.propose(threshold, proposal, lengthBound)`,
   with a polkadot.js Apps link that opens it ready to sign. The threshold is
   read live: `TechCommitteeMajority` is at least half, so 4 of today's 7.
3. A member submits it. Voting starts empty: the proposer's aye is **not**
   automatic, so 4 members vote aye, the proposer included.
4. Anyone closes it with the printed bounds.
5. Read `ClearingV2.positions(vault).maxTotalSupply`. The dispatcher reports
   `Ok` even when the inner `evm.call` reverts, so this read is the only proof.

The motion pins a max gas price (`eth_gasPrice × GAS_PRICE_MULT`, 20 by
default). It still pays only the base fee, but fails if the base fee rises past
that cap before the close, and a motion can stay open for 5 days.

Rehearsed on a chopsticks fork of mainnet at block 14,948,259: proposed, voted
4 of 7 and closed by the real members with mock signatures, the cap went from
150,000 to 250,000 shares, the other limits were unchanged, and a 100-HOLLAR
deposit that reverted before minted 312.68 shares after. `npm run fork`, then
`npm run test:fork` in a second terminal, runs `test/fork/tc-caps.fork.test.js`.

## What the handover actually moves

```text
                         BOOTSTRAP                 PRODUCTION
  Hypervisor.owner       deploy key            ->  Admin
  Hypervisor.whitelist   (unset)               ->  UniProxy
  Admin.admin            deploy key            ->  governance
  ClearingV2.owner       deploy key            ->  governance
  UniProxy.owner         deploy key            ->  governance
  RebalanceProxy.owner   deploy key            ->  governance
  HypervisorFactory      deploy key            ->  governance
```

The bottom four are the ones a port of `lark/01-deploy.ts` leaves behind, and
leaving them keeps the whole Model B story theoretical. That key could:

- `UniProxy.transferClearance(x)` — repoint deposits at a clearing contract with
  no TWAP guard, no ratio check and no caps;
- `RebalanceProxy.exemptHypervisor(v)` — drop `maxTranslation`, `maxWidth` and
  `minInterval` in one call, so a compromised keeper key is unbounded again;
- `ClearingV2.appendList(v, [attacker])` — grant a free-deposit exemption from
  the ratio checks;
- `ClearingV2.customRatio(v, true, faux0, faux1)` — lie about the vault's
  composition and mint shares against it.

`04-verify.js` fails when any role is still held by the deploy key.

## Launch boundaries

- **The pool must exist first.** `V3_FACTORY` and `V3_POOL` come from
  `uniswap-v3-deploy/mainnet/deployments/mainnet.json` and `…-pool.json`. The
  preflight proves the configured factory really does map the pair to the
  configured pool, because the v3 stack is CREATE-deterministic and one chain's
  factory address is another chain's Multicall2.
- **The pool needs an hour of real trading before the seed can land.**
  ClearingV2 calls `observe(twapInterval)` on every deposit and it reverts for
  any window longer than the pool's actual history. The preflight makes that
  static call rather than trusting the cardinality number.
- **The treasury must hold both assets before the seed, and today it does not.**
  Re-measured on mainnet 2026-09-07 (block 14,314,069), the treasury EVM identity
  `0x6d6f646c…` held **483,241 HOLLAR** and **361.14 aDOT**. A seed of $5,000 per
  side needs **5,205.25 aDOT** at the 2026-09-07 price — a shortfall of
  ~4,844 aDOT (~$4,653). The HOLLAR side is amply funded; the aDOT side has to be
  acquired first, and is funded manually rather than by this tooling.
  `01-governance-calldata.js seed` reads both balances and refuses to encode a
  proposal the treasury cannot pay for, so this fails loudly rather than after
  enactment.

  Two acquisition paths exist on chain, both dispatchable as the treasury:
  aDOT (1001) and HOLLAR (222) are **both Omnipool assets**, so `HOLLAR → aDOT`
  is a single Omnipool hop; and the router carries a stored `5 → 1001` route
  through a `PoolType::Aave` hop, which is the DOT-supply-mints-aDOT path. The
  treasury's 48.58 DOT is nowhere near enough on its own.
  **Not yet rehearsed:** whether a treasury-dispatched sell settling in aDOT
  stays inside the runtime's ERC-20 transfer gas budget — `Erc20Currency`
  hardcodes 400k and an aToken transfer measures ~1.23M, which is what stops
  `currencies.transfer` moving aDOT at all. Rehearse the acquisition on the fork
  before writing the referendum.
- **`GOVERNANCE_ADDRESS` must be a governance-controlled EVM identity.**
  `0xaa7e…aa7e0` is `dispatcher.dispatchAsAaveManager` (Root or the
  EconomicParameters track), already the Aave market's ACLManager admin.
  Economics study P5 chose it over a multisig deliberately.
- **The keeper key is separate and deliberately hot.** It is
  `RebalanceProxy.rebalancers[vault]` and `Admin.advisors[vault]` — bounded
  rebalancing and compounding, nothing else. The preflight refuses to make it
  the deployer or governance.

## Decisions already made — do not re-open

| Item | Value | Source |
| --- | --- | --- |
| Pair / fee | aDOT (1001) / HOLLAR (222), 3000 | `note-univ3-gamma-adot-hollar`, ALM spec §A |
| `token0` | **aDOT** — contract sort inverts the asset-ID sort | verified against the registry |
| Launch band | ±10% = `BASE_HALF_WIDTH_MULT=16` at spacing 60 | ALM spec §D1 (D5) |
| Proxy caps | `maxTranslation` 500, `maxWidth` 300, `minInterval` 6h | ALM spec §C |
| ClearingV2 | `twapInterval` 3600, `priceThreshold` 10_100 (1%) | ALM spec §B |
| `maxTotalSupply` | 150,000 shares — a share count, not USD (≈ $150k only at launch) | economics study P4 |
| Gamma fee divisor | 255 (≈0.4%) at launch | ALM spec §H D3 |
| Admin's admin | `0xaa7e…aa7e0`, not a multisig | economics study P5 |
| `directDeposit` | off | ALM spec §B |

## Things that will bite

- **Always pass `ENV_FILE`.** With it unset, `lib.js` falls back to
  `mainnet/.env`. There is no such file now, and there should not be one — a
  stray `.env` would silently redirect a mainnet command at another chain.
- **`customDepositDelta` may never be 0 while `depositOverride` is on.**
  `ClearingV2.applyRatio` divides by it, so a zero makes every deposit *after
  the first* revert inside `FullMath.mulDiv`. The first deposit takes the
  `totalSupply() == 0` branch and never touches `applyRatio`, so a smoke test
  that deposits once passes. `lark/01-deploy.ts` passes 0.
- **Caps are stored and enforced by two different calls.** `customDeposit`
  stores the per-tx maxima; `setDepositOverride(pos, true)` is what makes
  `clearDeposit` read them. Without the second, the Hypervisor's own unlimited
  constructor values apply. `maxTotalSupply` is different again — it is checked
  in `clearShares` *after* the mint, so an over-cap seed reverts the whole
  enacted transaction.
- **`maxTotalSupply` caps shares, not USD.** `clearShares` compares
  `totalSupply()` with it and reads no price, so the dollar size of a full
  vault floats with the aDOT price and the vault's own gains and losses.
  "≈ $150k" held only at the first deposit, which mints one share per HOLLAR
  of value. On 2026-09-23 a share was worth 0.914 HOLLAR, so the
  150,000-share cap filled at ~137,100 HOLLAR. To size a new cap, divide the
  dollar target by the value per share at the time, and expect it to drift.
- **The seed's allowance goes to the Hypervisor, not UniProxy.** `UniProxy`
  forwards `from = msg.sender` and the Hypervisor is what calls `transferFrom`.
  Approving UniProxy compiles, submits, enacts, and reverts.
- **The launch band must match the keeper's.** The band set at handover is the
  baseline `RebalanceProxy.maxWidth` is measured against; if the keeper's first
  rebalance re-mints at a width further away than the cap, the proxy reverts
  with `Exceeds width delta` and the keeper skips forever, silently. `lib.js`
  transcribes `keeper/src/ticks.ts` for exactly this reason and the unit test
  pins the worst-case delta.
- **Gas is fixed, not estimated.** Hydration's `eth_estimateGas` under-reports
  and ethers sends the estimate verbatim; a status-0 receipt that burned exactly
  the estimate is that, not a logic revert. `gasPrice` is also pinned, because
  an under-priced transaction is dropped at apply *without producing a receipt*
  and the script then hangs on `.wait()` forever.
- **aDOT is an aToken, so its transfers are expensive.** A `transferFrom` runs
  `finalizeTransfer` and measured **1,232,829 gas** — over three times the 400k
  `Erc20Currency` hardcodes, which is why `currencies.transfer` cannot move it
  at all and why the seed's inner `evm.call` budgets 6M.
- **Resume state is chain-specific.** `deployments/<net>-state.json` records
  addresses only; `02-deploy.js` refuses to resume when any recorded address has
  no code on the target chain. Do not delete it to "get past" the error.
- **`Admin.fixOwnership()` does nothing.** It assigns `ownerFixed = false` — the
  value it already has. There is no way to permanently fix vault ownership;
  `Admin.transferHypervisorOwner` stays available to governance forever.
- **`Admin.compound(address)` reverts.** `IHypervisor` declares a no-argument
  `compound()` that `Hypervisor.sol` does not implement. Only the bounded
  `compound(address,uint256[4])` overload works, which is the one the keeper
  calls. Same for `Admin.addBaseLiquidity` / `addLimitLiquidity` — no such
  functions exist on the Hypervisor.

## Pools 2-5: one stack, four vaults, ownership last

A fresh Gamma stack, named by `STACK`, holds one vault per file in `pools/`.
The deploy key does every setting; ownership moves once, last, for all of them.
`.env.pools` holds only the shared settings and the key.

```bash
cp .env.pools.example .env.pools                                      # set DEPLOYER_PK
# per pool, once its uniswap-v3-deploy pool exists and its caps/seed are set (runbook §7)
ENV_FILE=.env.pools ./launch-pool.sh pools/atbtc-hollar.env            # preflight, deploy the vault, configure it
# once, when every pool in STACK_POOLS is configured
ENV_FILE=.env.pools npm run transfer-ownership -- --check              # read-only
ENV_FILE=.env.pools npm run transfer-ownership
# per pool
ENV_FILE=.env.pools POOL_FILE=pools/atbtc-hollar.env npm run verify
ENV_FILE=.env.pools POOL_FILE=pools/atbtc-hollar.env npm run governance -- seed        # treasury seed: a track-5 proposal
# ...or skip the treasury and seed from a wallet you control (same SEED0/SEED1, same checks)
ENV_FILE=.env.pools POOL_FILE=pools/atbtc-hollar.env SEEDER_PK=0x… npm run seed-wallet -- --check
ENV_FILE=.env.pools POOL_FILE=pools/atbtc-hollar.env SEEDER_PK=0x… npm run seed-wallet
```

- The seed lands idle. Compounding stays off (a timed sweep is a sandwich
  target), so the keeper mints it with one ordinary re-center once it sees
  shares with nothing in the pool, after its dwell (~30 min in a calm regime;
  an elevated one exceeds the proxy's width cap, so it waits for calm). Start
  the keeper with this vault's file before seeding.
- `SEED_TO` unset: the LP shares go to whoever pays, the treasury or the
  seeding wallet. `seed-wallet -- --check` prints where they will go.

- Records: `deployments/<net>-<STACK>-state.json` for the shared contracts,
  `<net>-<STACK>-<pool>.json` per vault. Pool 1's `mainnet.json` is never touched.
- With a pool file, `03-handover.js` stops after the launch band and whitelist
  (`configured`). `05-transfer-ownership.js` refuses unless the factory holds
  exactly `STACK_POOLS`, each still configured; then vaults → Admin, shared
  contracts → governance, Admin last, and it fails if the deploy key keeps any role.
- Price drifted since the pool was created: `ENV_FILE=.env.anchor
  POOL_FILE=pools/<pool>.env node 11-anchor-price.js`. That anchor env holds only
  the key, RPC and gas settings.
- `02-deploy.js` writes each pool's keeper file to
  `keeper/vaults/<net>-<STACK>/<pool>.json`. Commit them, add them to
  `keeper/deploy/vaults.mainnet.json` after pool 1, and ship that as a new swarm
  config version, after the ownership transfer: the keeper rebalances through Admin.
- The vault files do not set `ORACLE_MAX_DEV_TICKS`, so the new vaults take
  whatever the running keeper stack has (runbook §3, §5.13). Read it from the
  keeper's startup banner (`oracle … (maxDev N, maxAge Ns)`) and decide it is
  right for these bands before adding the files.

## Rehearsing on a chopsticks fork of mainnet

`10-chopsticks-rehearsal.js` drives the whole flow against a local fork and
refuses to run against a non-local `WS_URL`.

```bash
# Terminal 1 — fork mainnet
npm install @galacticcouncil/chopsticks@2.3.0
cat > hydradx-mainnet.yml <<'YML'
endpoint:
  - wss://rpc.hydradx.cloud
  - wss://hydration-rpc.n.dwellir.com
block: <pin a recent block>
mock-signature-host: true
db: ./db-mainnet.sqlite
port: 8001
YML
node node_modules/@galacticcouncil/chopsticks/chopsticks.cjs --config hydradx-mainnet.yml

# Terminal 2 — the launch, with WS_URL/EVM_RPC_URL pointed at localhost:8001
ENV_FILE=.env.fork node 10-chopsticks-rehearsal.js govern      # fixture: gas + CREATE whitelist
#   ... run uniswap-v3-deploy/mainnet 02-deploy.js and 03-create-pool.js here ...
ENV_FILE=.env.fork node 10-chopsticks-rehearsal.js warm-twap   # jump the clock past twapInterval
ENV_FILE=.env.fork npm run preflight
ENV_FILE=.env.fork npm run deploy
ENV_FILE=.env.fork npm run handover
ENV_FILE=.env.fork npm run verify
ENV_FILE=.env.fork node 10-chopsticks-rehearsal.js seed        # 01's exact encoding, dispatched as Treasurer
ENV_FILE=.env.fork node 10-chopsticks-rehearsal.js fund <eoa>
ENV_FILE=.env.fork node 10-chopsticks-rehearsal.js deposit2    # SECOND deposit + withdraw
ENV_FILE=.env.fork node 10-chopsticks-rehearsal.js rebalance   # keeper -> proxy -> admin -> vault
```

`seed` builds its call with the same exported function `01-governance-calldata.js`
prints, so the rehearsal cannot drift from what gets submitted.

### Fork-only gotchas, all of them load-bearing

- **The seed is dispatched under `Origins::Treasurer`, not Root.** Fixture
  calls that have no mainnet counterpart (gas, balances, the CREATE allowlist)
  use Root; the seed carries the same origin its referendum will, so the fork
  proves the narrow origin satisfies `TreasuryManagerOrigin` rather than
  proving only that Root does.
- **A governance origin arrives via a `Lookup`-bounded preimage, not `Inline`.**
  `BoundedInline` is `BoundedVec<u8, ConstU32<128>>` and every call worth
  rehearsing is bigger. Over the limit the agenda entry is written and *silently
  skipped*: the block builds, no failure marker is emitted, and the call never
  ran. The script writes the preimage first and asserts a `scheduler.Dispatched`
  actually appeared.
- **`dev_setStorage`'s JSON form drops the length prefix on a `Bytes` value.**
  The preimage is written through the raw `[[key, value]]` form instead.
- **A `Scheduled` entry needs all five fields.** `{ call, origin }` alone reads
  back cleanly through `api.query` and dispatches nothing.
- **Minting WETH for gas trips the deposit circuit breaker.**
  `currencies.updateBalance` under Root emits `circuitBreaker.AssetLockdown` for
  asset 20 and then `tokens.Reserved` for the entire deposit, leaving the key
  with a visible balance it cannot spend. Fixture gas is written straight into
  `Tokens.Accounts` and `System.Account` instead.
- **TWAP history is bought with the clock, not with trades.** The pool's first
  observation is written at `initialize()`, so once `dev_timeTravel` moves `now`
  past `init + twapInterval`, `observe` interpolates instead of reverting.
- **Raise `STALE_SECONDS` on the fork.** Time-travelling ages the DIA feed, and
  the preflight's freshness check is measuring the fork's clock, not the feed.
- **Instant mode only auto-builds on a transaction's *arrival*.** A transaction
  that reached the pool during a Manual window — which every Root step opens —
  sits there forever once the mode flips back. The script restores Instant when
  a command finishes; if a run still hangs on `.wait()`, check
  `author_pendingExtrinsics` and flush it with one `dev_newBlock`.
- **Pin `block:` and list more than one `endpoint:`.** chopsticks fetches
  uncached storage from upstream and does not always recover from a dropped
  websocket; a pinned block means a restart reuses the sqlite cache instead of
  re-fetching everything. `resume: <block>` brings a wedged fork back at a chosen
  height with its EVM state intact.
- **`dev_setStorage` written onto the resume-base block does not survive a
  `resume`.** Only the diffs of blocks built afterwards are saved, so a slot that
  nothing subsequently re-wrote reverts to its forked value. An account funded
  that way and then left idle reads back as zero, while one that sent a
  transaction survives — its fee payment re-wrote the entry into a saved diff.
  The pool's backdated `observations[0]` is lost the same way, because writing
  `observations[1]` does not touch slot 0. **Re-run both `govern` and
  `warm-twap` after any restart**, and note that `warm-twap` is self-checking —
  it reports "nothing to do" when `observe` already succeeds.
- **chopsticks rejects roughly one signature in 256.** RLP encodes `r`/`s`
  minimally, so a leading zero byte yields 31 bytes and its decoder fails with
  "Expected input with 32 bytes (256 bits), found 31 bytes". A real Frontier node
  decodes it fine. `10-chopsticks-rehearsal.js` re-signs at a slightly different
  gas price rather than failing.

## Deliberately out of scope

- **The seed itself.** It is a referendum, printed here and submitted by a
  human, after the vault is live and the keeper is running.
- **Acquiring aDOT for the treasury.** See *Launch boundaries*.
- **Incentives.** No program is planned; aDOT incentivisation was deliberately
  ended (economics study P7).
- **Router registration.** The v3 venue is `uniswap-v3-deploy`'s concern and is
  gated on a runtime upgrade.

## Rehearsal record — 2026-09-07

Rehearsed end to end against a **chopsticks fork of mainnet** (runtime spec 440,
forked at block 14,314,069) and finished green. Unlike the 2026-09-03 run, the
venue underneath was **`uniswap-v3-deploy/mainnet`'s real deployment**, not a
bare-factory fixture: its `02-deploy.js` put the full v3 periphery on the fork,
`03-create-pool.js` created and initialised the pool at the live DIA price and
grew its ring to 2000, and its launch proposal was enacted before Gamma ran.
Nothing has been deployed to mainnet itself.

### Venue — `uniswap-v3-deploy/mainnet`

| Phase | Result |
| --- | --- |
| `preflight` | passed — deployer allowlisted, registry-resolved token order, ring sizing, feed freshness |
| `deploy` | all 12 contracts, the 1-bps fee tier, and both ownership transfers to `0xAa7e…Aa7e0`; `Deployment succeeded` |
| `pool` | pool `0x5098641e…` created and initialised at **0.960568 HOLLAR per aDOT**, ring grown 1 → 2000 in 8 chunks |
| `governance -- launch` | 190-byte `dispatcher.dispatchAsAaveManager`, preimage `0x7c3f97c3…` |
| *(that encoding enacted on the fork)* | `scheduler.Dispatched Ok`, 1 `evm.Executed`, zero failure markers |
| `verify` | passed — code at all 12 addresses, factory and ProxyAdmin owned by governance, pool tokens/fee/tick, protocol fee 4/4, 0 bps feed divergence |

### Gamma

| Phase | Result |
| --- | --- |
| `warm-twap` | `observe(3600)` went from reverting to succeeding; TWAP tick 183813 vs spot 183813 |
| `preflight` | passed — roles, registry-resolved token order, linkage to the real pool, TWAP readiness, band-vs-`maxWidth`, caps, seed-vs-cap, feed, reserve pause |
| `deploy` | 6 contracts + 11 configuration calls |
| `verify` (bootstrap) | passed — deploy key owns everything, whitelist unset, band unset |
| `handover` | all 7 steps; band `[182820, 184800]` at tick 183813, exactly as preflight predicted |
| `verify` (production) | passed — **`deploy key holds no role`**, live `clearDeposit` probe |
| `governance -- seed` | printed a 765-byte `utility.batchAll`, preimage `0xc3e0b377…`, **track 5 (`treasurer`)**; nothing submitted |
| *(that exact encoding dispatched with `origin: {Origins: Treasurer}`)* | 3 `evm.Executed`, zero failure markers; treasury received **672.397753999999999999 shares — the preflight's prediction to the last digit**. This is the evidence that **`Treasurer` alone satisfies `TreasuryManagerOrigin`**; Root is an option, not a requirement |
| `deposit2` | a SECOND deposit minted 1.921136906048304452 shares through `applyRatio`, then redeemed 1.0000002673 aDOT + 0.96056823371411296 HOLLAR in kind |
| `rebalance` | keeper → RebalanceProxy → Admin → Hypervisor landed |
| `verify -- events` | the seed block scanned clean: 3 `evm.Executed`, no failure markers |

What the rehearsal did **not** cover: the referendum machinery itself (deposits,
tracks, conviction, enactment delay).

Defects caught by the rehearsals and fixed here rather than worked around:

1. `ClearingV2.customDeposit(..., customDepositDelta = 0)` with
   `setDepositOverride(true)` — as `lark/01-deploy.ts` passes it — reverts every
   deposit after the first. `DEPOSIT_DELTA` now defaults to 10,010 and preflight,
   deploy, handover and verify each refuse a zero.
2. The handover moves **all six** owner roles. A port of the testnet script moves
   two and leaves `ClearingV2`, `UniProxy`, `RebalanceProxy` and the
   `HypervisorFactory` with the deploy key.
3. `verify -- events <first> <count>` ran off the chain head. `getBlockHash`
   past the tip returns the zero hash instead of erroring, and `api.at()` then
   threw `Block not found` — which reads like a failed verification when it is
   only an over-long range. The scan now clamps to the head and says so.
4. The v3 deploy CLI appears to hang on chopsticks. It is not hung: Instant mode
   only builds a block when a transaction *arrives*, so the CLI's wait for a
   confirmation never resolves. Poll `author_pendingExtrinsics` and call
   `dev_newBlock` when it is non-empty; the full periphery then deploys normally.

## Hand back after launch

Archive, with `DEPLOYER_PK` removed: the reviewed configuration, the generated
`deployments/<net>.json`, the seed proposal's preimage and hash, its referendum
index, the enactment block range, and the passing `verify` and
`verify -- events` output.
