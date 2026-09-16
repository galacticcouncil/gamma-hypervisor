# Two-position strategy simulator

Backtests the keeper's strategy variants against real DIA DOT/USD oracle tapes,
to settle parameter arguments with numbers instead of taste. This is the
evidence base for `FOLD_ENABLED` and for the `BASE_SKEW_ENABLED` evaluation on
PR #7.

```
python3 sim2pos.py
```

No dependencies beyond the standard library. Prints, per tape, one line per
variant: rebalance/refresh/fold counts, fees, time-weighted base share, ending
NAV, and the delta vs a 50/50 HODL of the same starting capital.

## What it models

- **Positions**: mult-16 base band and 960-tick one-sided limit, exactly the
  mainnet aDOT/HOLLAR deployment (spacing 60, fee 0.3%).
- **Triggers**: re-center at 660-tick drift from the band mid, limit refresh at
  120 ticks outside the limit, both with a 2-sample (~30 min) dwell and a
  shared 6 h cooldown — the live keeper's configuration.
- **Price**: the pool chases the DIA oracle inside a 0.3% fee dead-band (an
  arbitrageur moves the pool only when the gap beats the fee); fees accrue on
  the input volume of every crossing, across whichever positions it traverses.
- **Rebalances never swap**: base minted scarce-side-constrained at the current
  price, surplus into the one-sided limit, exactly like the Hypervisor.

## Variants

| variant | flag | what it adds |
|---|---|---|
| A | — | current mainnet config (recenter + refresh) |
| B | `fold=True` | **fold at balance**: zero-translation rebalance once the limit is ≥40/60 mixed |
| C | `fold=True, confirm=True` | fold only when the last 30 min moved back toward the band mid |
| D | `skew=True` | inventory-skewed base band (PR #7, min leg 8×spacing, max ratio 8) |
| E | `skew=True, fold=True` | both |

## Tapes (real DIA `latestAnswer` reads, real block timestamps)

| file | period | character |
|---|---|---|
| `dia_true.json` | Jul 27 – Aug 26 (30 d) | whipsaw, +5.5% net |
| `dia_true_90d.json` | May 28 – Aug 26 (90 d) | bear + bounce, −28% |
| `dia_live_tape.json` | Aug 29 – Sep 16 (18 d) | the pool's actual launch window, +17% |

`harvest_live.py` / `harvest90.py` regenerate them from the mainnet DIA feed
(`0xFBCa…6702`) — they bisect block *timestamps* rather than assuming a fixed
block time, because Hydration's 6 s → 2 s transition makes linear block↔time
extrapolation silently wrong.

## Results (2026-09-16)

```
=== 30d whipsaw ===   A −6.88% | B −6.14% | C −6.21% | D −11.64% | E  −9.60%  vs HODL
=== 90d bear ===      A −17.11% | B −15.92% | C −18.87% | D −19.46% | E −16.65%
=== launch tape ===   A −18.28% | B −16.09% | C −15.74% | D −17.73% | E −16.31%
```

B (fold) is the only variant that beats A on **all three** tapes. C wins the
launch tape but loses the bear badly — the same regime-fitting failure mode as
the retracted lazy-recentering idea. D (skew) produces the highest fees and the
worst NAV of any variant on two of three tapes: it holds the whole NAV in-range,
and participation is the LVR cost, not the prize. Its elevated re-center counts
come from the drift trigger still measuring from the band mid, which a skewed
band is born away from.

## Honest caveats

Arb-only flow (no organic volume), the pool follows the oracle with a fee
dead-band (no depth feedback), fees are held as cash rather than compounded,
and dwell is samples not blocks. All of these are identical across variants, so
**relative rankings are meaningful; absolute P&L is not**.
