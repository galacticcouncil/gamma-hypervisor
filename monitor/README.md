# Gamma monitor

Watchdog for the Gamma keeper. Deployed as a **sibling** service in the same
stack, not as part of the keeper — the failure that matters most is the keeper
not running at all, and a health check inside that process cannot report it.
Every signal here is read from chain, so it holds whether the keeper is healthy,
crashed, or deleted.

## What it checks

| Check | Fires when | Why it matters |
|---|---|---|
| gas floor | keeper WETH < `GAS_FLOOR_WEI` | the keeper skips every rebalance and compound, silently |
| gas warning | keeper WETH < `GAS_WARN_WEI` | set above the floor so there is time to act **before** it stops |
| rebalance overdue | drift > `REBALANCE_THRESHOLD_MULT x tickSpacing` for longer than `MIN_INTERVAL_SECS + REBALANCE_GRACE_SECS`, and no price gate explains it | work was due and did not happen |
| limit stranded | spot more than `LIMIT_REFRESH_TICKS` outside `[limitLower, limitUpper)` for longer than the same allowance | the one-sided limit routinely carries most of NAV; it can sit entirely past spot earning nothing while the base stays well inside its drift threshold, invisible to every other check |
| oracle clamp blocking | pool TWAP vs oracle > `ORACLE_MAX_DEV_TICKS` **and** something above is waiting on it | the keeper is right to hold, but nothing can re-centre, refresh or compound until it closes |
| band | spot outside `[baseLower, baseUpper)` | ClearingV2 rejects every deposit with `price out of base range` |
| pause | `ClearingV2.paused()` | deposits disabled |
| feed staleness | feed age > `STALE_SECONDS` | the keeper's oracle clamp refuses to rebalance |
| divergence | pool vs feed > `DIVERGENCE_BPS` | with liquidity present, arbitrage should close this; persistent drift means none is reaching the pool |

Alerts are **edge-triggered**: fire on transition, repeat only every
`REALERT_SECS`, and send one recovery message when the condition clears. An RPC
failure is logged and skipped rather than reported as a healthy chain.

## Two things it deliberately does not do

**It does not treat a quiet keeper as a broken one.** A healthy keeper is silent
for days — it acts only when displacement, dwell and the 6h interval line up,
and its hourly compound is a no-op whenever nothing has accrued. An earlier
nonce-based liveness check produced a day of false criticals on a keeper that
was working correctly throughout. Liveness is measured as *work that was due and
did not happen*, read from chain, so it holds whether the keeper is healthy,
crashed, or deleted.

**It does not compare spot to the oracle when mirroring the keeper's clamp.**
The keeper gates on `twapTick ?? spotTick` versus the feed, so the watchdog
builds the same `TWAP_WINDOW_SECS` average or it disagrees with the thing it is
watching — in both directions. Measured on 2026-09-17 15:38 UTC: spot was 39
ticks from the oracle (so a spot-based rule stayed quiet about the clamp) while
the TWAP was 121 ticks away and the keeper was in fact blocked. The result was a
critical alert blaming a keeper that was behaving correctly. `TWAP_WINDOW_SECS`,
`MIN_TWAP_WINDOW_SECS`, `ORACLE_MAX_DEV_TICKS`, `REBALANCE_THRESHOLD_MULT`,
`MIN_INTERVAL_SECS` and `LIMIT_REFRESH_TICKS` must all match the keeper's, or
this check silently drifts from what it is watching.

## Run

```sh
npm install
RPC_URL=… KEEPER=0x… VAULT=0x… POOL=0x… CLEARING=0x… PRICE_FEED=0x… npm run once
```

`ONCE=true` runs a single cycle and exits. Omit `DISCORD_WEBHOOK` to log only.
