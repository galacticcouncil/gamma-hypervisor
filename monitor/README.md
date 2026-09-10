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
| liveness | nonce unchanged for `STALL_MINUTES` | container down, wedged, or unable to price a transaction |
| band | spot outside `[baseLower, baseUpper)` | ClearingV2 rejects every deposit with `price out of base range` |
| pause | `ClearingV2.paused()` | deposits disabled |
| feed staleness | feed age > `STALE_SECONDS` | the keeper's oracle clamp refuses to rebalance |
| divergence | pool vs feed > `DIVERGENCE_BPS` | with liquidity present, arbitrage should close this; persistent drift means none is reaching the pool |

Alerts are **edge-triggered**: fire on transition, repeat only every
`REALERT_SECS`, and send one recovery message when the condition clears. An RPC
failure is logged and skipped rather than reported as a healthy chain.

A quiet keeper is not a broken one — it acts only when displacement, dwell and
the 6h interval all line up — which is why liveness is a nonce gap measured in
hours, not minutes.

## Run

```sh
npm install
RPC_URL=… KEEPER=0x… VAULT=0x… POOL=0x… CLEARING=0x… PRICE_FEED=0x… npm run once
```

`ONCE=true` runs a single cycle and exits. Omit `DISCORD_WEBHOOK` to log only.
