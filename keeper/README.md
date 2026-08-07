# Gamma keeper

Off-chain keeper for the Gamma ALM Hypervisor on Hydration. Each block it reads the
Uniswap-v3 pool tick and, when price has drifted out of (or far from the center of)
the vault's base band, calls `rebalance(...)` to re-center.

## The manipulation question (read this first)

A concentrated-liquidity vault that re-centers on **spot** is exploitable: push the
pool with one large swap, let the keeper burn and re-mint the vault's liquidity
around the fake price, then unwind through the misplaced liquidity. This is the
canonical Gamma/Alpha-Vaults attack, and it is what the gates below exist to stop.

Four independent layers, each of which alone would blunt the attack:

| Layer | What it does | Config |
|---|---|---|
| **Placement off TWAP** | Spot may *trigger* a rebalance; the band is centered on the pool **TWAP** tick. Pushing spot cannot drag the band to the pushed price. | `TWAP_ENABLED` |
| **Deviation gate** | If spot and TWAP disagree by more than `MAX_DEV_TICKS`, do nothing at all. | `MAX_DEV_TICKS` |
| **Dwell + cooldown** | The trigger must hold for `DWELL_BLOCKS` consecutive blocks, and rebalances are `MIN_INTERVAL_SECS` apart. Flash loans do not survive a block boundary; holding a fake price for real time costs real money and bleeds to arbitrage. | `DWELL_BLOCKS`, `MIN_INTERVAL_SECS` |
| **External oracle clamp** | The pool TWAP itself is walkable given enough capital and patience. A DIA feed is not. Rebalance only if the pool agrees with the outside world. | `ORACLE_*` |

Plus **non-zero slippage bounds** (`MINS_TOLERANCE_BPS`): if the price moves between
the decision and the tx landing, the rebalance reverts rather than executing at the
moved price.

Two things worth being explicit about:

- **A private keeper is not a defense.** The band and the spot price are on-chain
  and the reaction is deterministic, so an attacker can predict the keeper without
  seeing its config. Keeping it private is fine for operational reasons; it is not
  what makes this safe.
- **Fail-closed everywhere.** If the TWAP is unreadable, the oracle is stale, or a
  gate cannot be evaluated, the keeper **skips**. Never rebalance on missing data.

## Access model — who may call `rebalance`

`Hypervisor.rebalance` is `onlyOwner` and the caller chooses the fee recipient, the
tick ranges and the slippage mins, so ownership is the whole security boundary.

| `ENTRYPOINT` | Owner | Keeper holds | Risk if the key leaks |
|---|---|---|---|
| `direct` (Model A) | the keeper key | full vault ownership | **total** — dev/local only |
| `proxy` (Model B) | `Admin` | a revocable low-privilege `rebalancer` key | bounded on-chain by `minInterval` / `maxTranslation` / `maxWidth` |

**Use `proxy` anywhere that isn't a throwaway chain.** In proxy mode the keeper reads
the on-chain caps each decision and walks the band toward its target within
`maxTranslation` per interval, so a compromised key cannot relocate the vault's
liquidity in one move. `zombienet/configure-guards.ts` sets this up.

## Run

```sh
cd gamma-hypervisor/keeper
cp .env.example .env
npm install
npm test          # unit tests — tick math, TWAP, mins, oracle (no chain needed)
npm run smoke     # read-only: shows every gate's reading and which would stop it
npm run dry       # log a decision every block, send nothing
npm start         # live
```

Bring the chain + vault up first (see `../zombienet/README.md`). To watch a rebalance
fire, push the pool price with a large swap, then wait `DWELL_BLOCKS` blocks.

## How it decides (each block)

1. read `pool.slot0()` (spot tick) and the vault's `baseLower/baseUpper`;
2. **trigger** if spot left the band, or drifted more than `REBALANCE_THRESHOLD_MULT × tickSpacing` from its center;
3. **dwell** — the trigger must hold `DWELL_BLOCKS` blocks in a row;
4. **cooldown** — `MIN_INTERVAL_SECS`, and the proxy's on-chain `minInterval`;
5. **TWAP gate** — window clamped to the pool's actual history; skip if `|spot − TWAP| > MAX_DEV_TICKS`. The TWAP tick becomes the **placement** tick;
6. **oracle clamp** — skip if the pool disagrees with DIA by more than `ORACLE_MAX_DEV_TICKS`, or the feed is older than `ORACLE_MAX_AGE_SECS`;
7. **gas floor** — skip if the signer's WETH balance is below `GAS_FLOOR_WEI`;
8. compute the base band around the **placement** tick (`±BASE_HALF_WIDTH_MULT × tickSpacing`), clamped to the proxy's `maxTranslation`; place the limit range one-sided on the surplus token;
9. derive `inMin`/`outMin` from the current positions and price, less `MINS_TOLERANCE_BPS`;
10. `eth_call` **preflight**; if it would revert, log and skip;
11. **submit** with a pinned `pending` nonce + `CONFIRMATIONS`.

## Config (`.env`)

| var | default | meaning |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:9999` | EVM JSON-RPC |
| `PRIVATE_KEY` | — (required) | owner key (`direct`) or rebalancer key (`proxy`) |
| `VAULT` | zombienet Hypervisor | Gamma vault address |
| `ENTRYPOINT` | `direct` | `direct` (Model A) or `proxy` (Model B) |
| `REBALANCE_PROXY` | — | RebalanceProxy address; required when `ENTRYPOINT=proxy` |
| `FEE_RECIPIENT` | — (required live) | recipient of the protocol fee cut — **the Treasury** |
| **strategy** | | |
| `BASE_HALF_WIDTH_MULT` | `10` | base half-width, in tickSpacings |
| `LIMIT_WIDTH_MULT` | `1` | limit width, in tickSpacings |
| `REBALANCE_THRESHOLD_MULT` | `5` | drift trigger, in tickSpacings |
| **gates** | | |
| `MIN_INTERVAL_SECS` | `600` | min seconds between rebalances |
| `DWELL_BLOCKS` | `3` | consecutive triggering blocks required |
| `TWAP_ENABLED` | `true` | gate spot vs pool `observe()` TWAP, and place off TWAP |
| `TWAP_WINDOW_SECS` | `3600` | TWAP window (clamped to available history) |
| `MIN_TWAP_WINDOW_SECS` | `600` | refuse to act on less history than this |
| `MAX_DEV_TICKS` | `100` | max spot-vs-TWAP deviation (~1%) |
| `ALLOW_UNSAFE_SPOT` | `false` | permit a live run with `TWAP_ENABLED=false` (local only) |
| `MINS_TOLERANCE_BPS` | `1000` | slippage bound per leg |
| **oracle clamp** | | |
| `ORACLE_ENABLED` | `false` | require agreement with an external feed |
| `ORACLE_ADDRESS` | — | DIA-style `getValue(string)` oracle |
| `ORACLE_KEY0` / `ORACLE_KEY1` | — | feed keys, e.g. `DOT/USD`; omit `KEY1` if token1 is the USD side |
| `ORACLE_PRICE_DECIMALS` | `8` | feed decimals (DIA: 8) |
| `ORACLE_MAX_AGE_SECS` | `600` | reject staler feeds |
| `ORACLE_MAX_DEV_TICKS` | `200` | max pool-vs-oracle deviation (~2%) |
| **operations** | | |
| `GAS_FLOOR_WEI` | `0` | skip if signer WETH-gas balance below this |
| `GAS_LIMIT` | `3000000` | rebalance gas limit |
| `CONFIRMATIONS` | `3` | confirmations to wait per tx |
| `POLL_INTERVAL_MS` | `2000` | block poll interval |
| `STARTUP_LOOKBACK_BLOCKS` | `50000` | how far back to find the last rebalance on start |
| `DRY_RUN` | `false` | decide + log, never send |

`MAX_DEV_TICKS`/`ORACLE_MAX_DEV_TICKS` are in ticks: **1 tick ≈ 1 basis point**, so
100 ticks ≈ 1%.

### Tuning `MINS_TOLERANCE_BPS`

The bound is on **leg amounts**, not price, and a leg's amount moves much faster
than price — so the tolerance buys less price headroom than the number suggests.
Measured trip points at the default 1000 bps:

| base band | price move that reverts |
|---|---|
| ±300 ticks (`BASE_HALF_WIDTH_MULT=5`, spacing 60) | ~0.30% |
| ±600 ticks (`=10`) | ~0.60% |
| ±1200 ticks (`=20`) | ~1.17% |

Reverting is the safe direction — it costs gas, not funds. But note the gate
interaction: `MAX_DEV_TICKS=100` lets the keeper proceed with spot up to 1% off
the TWAP, and a further move of the size above between the passing preflight and
inclusion reverts on-chain. **Narrow bands and volatile pairs want a wider
tolerance** (or a tighter `MAX_DEV_TICKS`); widening it weakens sandwich
protection proportionally.

Config refuses to start on the dangerous combinations: `ENTRYPOINT=proxy` without a
proxy address, a live run without `FEE_RECIPIENT`, `ORACLE_ENABLED` without a feed,
and a live run with the TWAP gate off unless `ALLOW_UNSAFE_SPOT=true`.

## Fees

`Hypervisor.fee` is a **divisor**, not a percentage: `fee = 5` means the fee recipient
takes **1/5 = 20%** of accrued swap fees, charged at every `zeroBurn` (deposit,
withdraw, rebalance). The `10%` in the contract's natspec is stale.

- `setFee(10)` → 10%, `setFee(5)` → 20% (default), `setFee(4)` → 25%.
- `setFee(0)` **bricks the vault** — `owed.div(0)` reverts, and `zeroBurn` is on the
  deposit, withdraw and rebalance paths. `setFee(1)` takes 100% of fees.
- The recipient is set from the **caller's argument on every rebalance** and persists
  until the next one, which is exactly why `rebalance` must not be permissionless.

## Preconditions on-chain

- **Grow the pool's observation cardinality** (`increaseObservationCardinalityNext`).
  A fresh pool has cardinality 1, so `observe()` reverts and *both* TWAP gates (this
  keeper's and ClearingV2's deposit check) are dead. The deploy scripts do this; the
  ring still has to fill before a full window is readable.
- **`ClearingV2.priceThreshold`** ships at `10_000`, which is compared as
  `price*10_000/priceBefore` and so allows **0%** deviation — every deposit reverts
  once a TWAP exists. Set `10_100` for 1%.
- **Whitelist the UniProxy, not an EOA.** `Hypervisor.deposit` is
  `onlyWhitelisted`; whitelisting a person bypasses ClearingV2 entirely.

## Hydration notes / gotchas

- **Gas is paid in WETH(20)**, not native — keep the signer's EVM balance funded;
  `GAS_FLOOR_WEI` guards it.
- Submits pin the **`pending` nonce** and wait for `CONFIRMATIONS` (default 3) to dodge
  the stale-pending **"nonce too low"** failure seen on lark.
- **`MaxUint256` approvals revert** — asset precompiles hold balances as `u128`, so
  `type(uint128).max` is the "infinite" sentinel.
- **First deposit ≠ active liquidity.** `deposit()` only escrows and mints shares;
  `rebalance()` is what deploys it into ranges.
- **Excluded assets:** rebasing / fee-on-transfer tokens and aTokens. The mins and
  ratio math assume balances don't move on their own, and rebase yield strands in
  the pool.
