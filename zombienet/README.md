# Gamma ALM on a local HydraDX zombienet

**Phase 2** of the Uniswap v3 + Gamma local deployment. Deploys the Gamma stack
(HypervisorFactory, Hypervisor, ClearingV2, UniProxy) on top of the Uniswap v3
from phase 1, over the KSM/KUSD asset precompiles, then runs an LP + swap smoke
test.

Phase 1 (Uniswap v3 + the zombienet itself) lives in the sibling
`uniswap-v3-deploy/zombienet/` and **must run first** — it brings up the chain
and writes the Uniswap addresses this phase consumes.

## Prerequisites

1. Phase 1 done and its zombienet **still running** (`uniswap-v3-deploy/zombienet`
   → `npm run e2e`). That leaves `http://127.0.0.1:9999` live and writes
   `uniswap-v3-deploy/zombienet/deployments/zombienet.json`.
2. Gamma deps installed (old toolchain needs legacy peer resolution):

   ```bash
   cd gamma-hypervisor
   npm install --legacy-peer-deps
   ```

## Run it

```bash
cd gamma-hypervisor
node zombienet/e2e.js          # compile → deploy gamma → smoke (LP + swap)
```

Or step by step, from the **repo root** (`gamma-hypervisor/`):

```bash
npx hardhat compile
npx hardhat run zombienet/deploy-gamma.ts --network zombienet
npx hardhat run zombienet/configure-guards.ts --network zombienet
npx hardhat run zombienet/smoke.ts            --network zombienet
```

> Order matters: `configure-guards` sets the vault's initial base range, and it
> does so with zero slippage mins — which is only safe while the vault is still
> **empty**. It refuses to run against a funded vault that has no band yet.

## What gets deployed (`deploy-gamma.ts`)

| Contract | Note |
| --- | --- |
| `HypervisorFactory(uniV3Factory)` | reads the phase-1 factory address |
| `Hypervisor` | `createHypervisor(KSM, KUSD, 3000)` — creates the pool if absent |
| pool `initialize(1:1)` | the factory creates the pool but leaves it uninitialized |
| pool `increaseObservationCardinalityNext(600)` | **TWAP history** — without it `observe()` reverts and every TWAP gate is dead |
| `ClearingV2` + `UniProxy(clearing)` | deposit-guard layer |
| `ClearingV2.addPosition` + `setPriceThreshold(10_100)` | the shipped `10_000` default allows **0%** deviation and rejects every deposit |
| `Admin` + `RebalanceProxy` | Model B: bounds the keeper key on-chain |
| `Hypervisor.setWhitelist(deployer)` | **bootstrap only** — `configure-guards.ts` switches it to UniProxy |

Output: `zombienet/deployments/zombienet.json` (uniswap + gamma + token config).

## Two postures

A fresh vault has `baseLower == baseUpper`, and `ClearingV2.clearDeposit` requires
the current tick to sit *inside* the base range — so the first deposit cannot go
through UniProxy. Deployment therefore has two stages:

| | whitelist | vault owner | who can rebalance |
| --- | --- | --- | --- |
| **bootstrap** (after `deploy-gamma.ts`) | deployer | deployer | the deployer key, unbounded |
| **production** (after `configure-guards.ts`) | `UniProxy` | `Admin` | the keeper key, bounded by `RebalanceProxy` caps |

`configure-guards.ts` is idempotent and safe to re-run: it sets the initial base
range if missing, flips the whitelist, verifies the whole Model B wiring, and only
then transfers ownership (refusing if the wiring is incomplete, which would leave
the vault unrebalanceable). `SKIP_OWNERSHIP=true` keeps the owner key for local
Model A experiments.

Run it with the **same `BASE_HALF_WIDTH_MULT` the keeper uses** — the band it sets
is the baseline the proxy's `maxWidth` is measured against, so a mismatch makes the
keeper's first rebalance an over-cap width change that skips forever. Both the
script and the keeper detect and report this. It also works against lark:

```bash
DEPLOYMENTS=lark/deployments/lark4.json \
  npx hardhat run zombienet/configure-guards.ts --network lark4
```

## What the smoke proves (`smoke.ts`)

- **Uniswap v3**: mint a KSM/KUSD position via `NonfungiblePositionManager`,
  then swap KSM→KUSD via `SwapRouter02`; asserts KUSD received.
- **Gamma**: deposit KSM+KUSD into the vault — directly in the bootstrap posture,
  via `UniProxy` once the whitelist has moved; asserts LP shares minted.
- **Guards**: asserts the pool's observation cardinality was grown, so both the
  keeper's TWAP gate and ClearingV2's deposit check can actually run.

The first `Hypervisor.deposit` only escrows tokens + mints shares; `rebalance(...)`
is what deploys them into the pool's base/limit ranges.

## Config

`--network zombienet` (added to `hardhat.config.ts`): `http://127.0.0.1:9999`,
chainId `2222222`, deployer = Charlie's EVM dev key. Override with `EVM_RPC_URL` /
`DEPLOYER_PK` / `UNISWAP_DEPLOYMENTS` env vars.

Guard knobs (all optional, sensible defaults):
`GAMMA_KEEPER` (keeper EVM address to register as rebalancer),
`OBSERVATION_CARDINALITY` (600), `PRICE_THRESHOLD` (10_100 = 1%),
`TWAP_INTERVAL` (60s locally, 3600 in prod), `MAX_TRANSLATION` / `MAX_WIDTH` (300
ticks), `MIN_INTERVAL` (600s).

> On a fresh chain the observation ring is grown but **empty**. `observe()` only
> reads back as far as the pool's actual history, so the keeper (which fails
> closed) will skip until `MIN_TWAP_WINDOW_SECS` of trading has accumulated. That
> is correct behaviour — wait it out rather than disabling the gate.
