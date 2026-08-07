# Gamma on lark1 — BOB lifecycle demo

End-to-end on the lark1 testnet: **BOB deposits into a Gamma vault and gets liquid
LP tokens; the keeper actively moves the position; BOB earns fees and withdraws.**

These are Hardhat scripts (deploy + fund + deposit + swap + report + withdraw). The
**keeper** (the `../keeper` bot) does the actual rebalancing between steps.

## The story (what each step demonstrates)

| step | who | what | the point |
|---|---|---|---|
| deploy | deployer | Gamma stack over lark1's live GLMR/ASTR pool | vault exists, owner = deployer (Model A) |
| fund-bob | deployer | send BOB ASTR + GLMR + WETH gas | BOB can play |
| bob-deposit | BOB | `deposit()` → receives `gASTR-GLMR` shares | **liquid LP tokens** |
| keeper (once) | keeper | first `rebalance()` | **keeper deploys BOB's liquidity into ranges** |
| fees | deployer | round-trip swaps + a drift swap | trading volume → fees, price moves |
| keeper (once) | keeper | `rebalance()` again | **keeper compounds fees + re-centers** |
| report | — | BOB's shares + redeemable value | **fees earned = value above deposit** |
| bob-withdraw | BOB | `withdraw()` → ASTR + GLMR back | principal + fees realized |

## Prerequisites

- lark1 already runs the v3-router runtime with the **GLMR/ASTR 0.3% pool live**
  (`0x8f86…9cf1`) — verified.
- The deployer (Anvil#0 `0xf39F…2266`) is **CREATE-whitelisted** (referendum 343)
  and funded with ASTR/GLMR/WETH — verified.
- `cd gamma-hypervisor && npm install --legacy-peer-deps && npm run compile`.

## Setup

Create `gamma-hypervisor/.env` (defaults are the standard lark dev keys; override if needed):

```sh
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80  # Anvil#0
BOB_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d        # Anvil#1 = BOB
# LARK_RPC_URL=https://1.lark.hydration.cloud   # default
```

## Run (in order)

```sh
cd gamma-hypervisor

npm run lark:deploy            # 1. deploy Gamma → writes lark/deployments/lark1.json
                              #    copy the printed Hypervisor address into keeper/.env (VAULT=)

npm run lark:fund-bob         # 2. deployer funds BOB
npm run lark:bob-deposit      # 3. BOB deposits → prints his LP shares (liquid tokens)

cd keeper && npm run once && cd ..   # 4. keeper deploys BOB's liquidity into ranges (1st rebalance)

npm run lark:fees             # 5. swaps → fees accrue + price drifts out of band

cd keeper && npm run once && cd ..   # 6. keeper compounds fees + re-centers (2nd rebalance)

npm run lark:report           # 7. BOB's shares + redeemable underlying (grown by fees)
npm run lark:bob-withdraw     # 8. BOB redeems principal + fees
```

The keeper step uses `keeper/.env` (see `keeper/.env.lark.example`): same owner key,
`VAULT=<lark hypervisor>`, narrow band + TWAP off so the drift swap triggers a
re-center. Use `npm start` instead of `npm run once` to watch it rebalance live
each block while you fire swaps from another terminal.

## Tunables (env on any step)

`FUND_ASTR`/`FUND_GLMR`/`FUND_WETH`, `BOB_DEPOSIT0`/`BOB_DEPOSIT1`,
`SWAP_IN`/`DRIFT_IN`/`ROUNDS`. Defaults: BOB deposits 100k+100k (a meaningful share
of the pool so his fees are visible); the drift swap is 50k one-way. If the keeper
doesn't re-center, raise `DRIFT_IN` or lower the keeper's `REBALANCE_THRESHOLD_MULT`.

## lark gotchas baked in

- **Gas is WETH(20)** — BOB is funded via a value transfer; the deployer holds ~40 WETH.
- **Approvals use the u128 sentinel** (`2^128-1`); `MaxUint256` overflows the precompile.
- **`CONFIRMATIONS=3`** on every tx (lark's stale-pending "nonce too low").
- **Explicit CREATE gas limits** (lark gas estimation under-shoots).
- **Deposit is `onlyWhitelisted`** (single slot) — `03` whitelists BOB before he deposits.

> ⚠️ This **deploys contracts and moves funds on the shared lark1 testnet**. Real
> txs, real gas. Run deliberately, step by step.
