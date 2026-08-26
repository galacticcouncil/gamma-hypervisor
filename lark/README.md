# Gamma on lark — BOB lifecycle demo

End-to-end on a lark fork: **BOB deposits into a Gamma vault and gets liquid LP
tokens; the keeper actively moves the position; BOB earns fees and withdraws.**

Defaults target **lark4** and its **aDOT/HOLLAR 0.3% pool**. Every address, token
and decimal is overridable via env (see `_shared.ts`), so the same scripts drive a
different fork or pair.

These are Hardhat scripts (deploy + fund + deposit + swap + report + withdraw). The
**keeper** (the `../keeper` bot) does the actual rebalancing between steps.

## The story (what each step demonstrates)

| step | who | what | the point |
|---|---|---|---|
| deploy | deployer | Gamma stack over the existing v3 pool | vault exists, owner = deployer (Model A) |
| fund-bob | deployer | send BOB both pool tokens + WETH gas | BOB can play |
| bob-deposit | BOB | `deposit()` → receives `gaDOT-HOLLAR` shares | **liquid LP tokens** |
| keeper (once) | keeper | first `rebalance()` | **keeper deploys BOB's liquidity into ranges** |
| fees | deployer | round-trip swaps + a drift swap | trading volume → fees, price moves |
| keeper (once) | keeper | `rebalance()` again | **keeper compounds fees + re-centers** |
| report | — | BOB's shares + redeemable value | **fees earned = value above deposit** |
| bob-withdraw | BOB | `withdraw()` → both tokens back | principal + fees realized |

## Prerequisites

- The target fork runs the v3-router runtime with the **aDOT/HOLLAR 0.3% pool live**
  (`0xc3139a43…` on lark4).
- The deployer (Anvil#0 `0xf39F…2266`) is **CREATE-whitelisted** and funded with
  aDOT / HOLLAR / WETH.
- `cd gamma-hypervisor && npm install --legacy-peer-deps && npm run compile`.

## Setup

Create `gamma-hypervisor/.env` (defaults are the standard lark dev keys; override if needed):

```sh
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80  # Anvil#0
BOB_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d        # Anvil#1 = BOB
# LARK_RPC_URL=https://node4.lark.hydration.cloud   # default
```

## Run (in order)

```sh
cd gamma-hypervisor

npx hardhat run lark/00-preflight.ts --network lark4   # 0. asserts the stack matches

npm run lark:deploy            # 1. deploy Gamma → writes lark/deployments/lark4.json
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
`VAULT=<hypervisor>`, narrow band + a short TWAP window so the drift swap triggers a
re-center. Use `npm start` instead of `npm run once` to watch it rebalance live
each block while you fire swaps from another terminal.

> The keeper refuses to move the band while spot is more than `MAX_DEV_TICKS` from
> the TWAP — that is the anti-manipulation clamp, not a failure. After a drift
> swap either wait out `TWAP_WINDOW_SECS` or lower it to 300 for a test run.

## Tunables (env on any step)

`FUND_TOKEN0`/`FUND_TOKEN1`/`FUND_WETH`, `BOB_DEPOSIT0`/`BOB_DEPOSIT1`,
`SWAP_IN`/`DRIFT_IN`/`ROUNDS`. Amounts are parsed at each token's own decimals.
Defaults are sized for the lark4 pool, which is thin — see the note in
`04-generate-fees.ts` before raising `DRIFT_IN`.

## lark gotchas baked in

- **Decimals differ per side** — aDOT is 10dp, HOLLAR is 18dp. Use `fmt0/fmt1`
  and `amt0/amt1`; the plain `fmt`/`amt` are 18dp and are for gas and LP shares
  only.
- **The v3 stack addresses collide across forks.** They are deployed from the same
  nonce sequence, so lark1's factory address is lark4's Multicall2 and lark1's NPM
  address is lark4's V3Staker. A stale default calls the *wrong contract* rather
  than failing — `00-preflight` asserts `factory.getPool(token0, token1, fee)`
  really is the configured pool.
- **Token addresses are not the id alias.** aDOT and HOLLAR are `Erc20`-kind
  assets living at a registered contract, not at `0x…01 ++ id`. The alias answers
  `symbol()`/`decimals()` but `getPool` against it returns the zero address.
- **Gas is WETH(20)** — BOB is funded via a value transfer.
- **Approvals use the u128 sentinel** (`2^128-1`); `MaxUint256` overflows the precompile.
- **`CONFIRMATIONS=3`** on every tx (lark's stale-pending "nonce too low"), and
  expect the occasional transient `transaction failed` that succeeds on retry.
- **Explicit CREATE gas limits** (lark gas estimation under-shoots).
- **Deposit is `onlyWhitelisted`** (single slot) — `03` whitelists BOB before he
  deposits if the vault has not yet been handed to UniProxy by
  `zombienet/configure-guards.ts`.
- **The vault's LP name/symbol are constructor args with no setter.** `01-deploy`
  derives them from the tokens' own `symbol()` — do not hardcode a literal, or
  the vault ships mislabelled forever.

> ⚠️ This **deploys contracts and moves funds on a shared lark testnet**. Real
> txs, real gas. Run deliberately, step by step.
