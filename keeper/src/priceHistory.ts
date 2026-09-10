/**
 * A short in-memory trail of feed prices, for the "moved X% in Y minutes" checks.
 *
 * Deliberately not persisted. It only needs ~1h, it is cheap to refill, and a
 * keeper that reloads a stale trail after a long outage would compare a fresh
 * price against an old one and read a normal market as a crash.
 *
 * The cost is a cold start: right after boot there is no 1h-ago sample, so
 * `moveOver` returns undefined and the caller falls back to the other triggers
 * rather than inventing a number.
 */
export interface PriceSample {
  ts: number;
  price: number;
}

export class PriceHistory {
  private samples: PriceSample[] = [];

  constructor(private readonly windowSecs: number) {}

  push(ts: number, price: number): void {
    if (!(price > 0) || !Number.isFinite(price)) return;
    const last = this.samples[this.samples.length - 1];
    if (last && ts < last.ts) return; // ignore out-of-order samples
    this.samples.push({ ts, price });
    const cutoff = ts - this.windowSecs;
    while (this.samples.length && this.samples[0].ts < cutoff) this.samples.shift();
  }

  get size(): number {
    return this.samples.length;
  }

  /**
   * Absolute fractional move between now and the oldest sample at least
   * `secs` old. Undefined when the trail does not reach back that far yet.
   */
  moveOver(secs: number, nowTs: number): number | undefined {
    const latest = this.samples[this.samples.length - 1];
    if (!latest) return undefined;

    const target = nowTs - secs;
    let ref: PriceSample | undefined;
    for (const s of this.samples) {
      if (s.ts <= target) ref = s;
      else break;
    }
    if (!ref || !(ref.price > 0)) return undefined;
    return Math.abs(latest.price - ref.price) / ref.price;
  }
}
