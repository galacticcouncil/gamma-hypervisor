import { withRetry } from './retry';
import { log } from './log';

/**
 * Baseline volatility from the neckwork indexer.
 *
 * The spec's "elevated" trigger compares current 1h realized vol against its
 * 30-day median. The 30-day part cannot come from the chain: a v3 pool remembers
 * at most its observation ring (~1h of busy trading), and the keeper is stateless
 * across restarts. So it comes from the indexer.
 *
 * That makes the indexer a dependency for ONE trigger, and it must not become a
 * dependency for the keeper. Every function here returns `undefined` rather than
 * throwing; callers fall back to the feed-based triggers, which need nothing
 * external.
 *
 * The series is DOT, not aDOT: the indexer does not track aDOT, and it does not
 * need to — aDOT is 1:1 with DOT (the balance rebases, the price does not), so
 * DOT/USD is the aDOT price with no index factor. Same reasoning as the oracle.
 */

export type Candle = {
  intervalStart: number;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
};

/**
 * Parkinson volatility for one candle: an intra-period estimate from the
 * high/low range, which is what "1h realized vol" means. Close-to-close would
 * miss everything that happened inside the hour.
 *
 *   sigma = sqrt( ln(H/L)^2 / (4 ln2) )
 */
export function parkinson(candle: Candle): number | undefined {
  const high = Number(candle.high);
  const low = Number(candle.low);
  if (!(high > 0) || !(low > 0) || high < low) return undefined;
  return Math.sqrt(Math.log(high / low) ** 2 / (4 * Math.LN2));
}

export function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface VolBaselineInput {
  baseUrl: string;
  baseId: number;
  quoteId: number;
  days: number;
  timeoutMs: number;
  nowTs: number;
}

/** Current 1h vol and its N-day median, or `undefined` if the indexer is unusable. */
export async function fetchVolBaseline(
  i: VolBaselineInput,
): Promise<{ current: number; median: number; samples: number } | undefined> {
  const from = i.nowTs - i.days * 86_400;
  const url =
    `${i.baseUrl.replace(/\/$/, '')}/candles` +
    `?baseId=${i.baseId}&quoteId=${i.quoteId}&interval=1h&from=${from}&to=${i.nowTs}`;

  try {
    const candles = await withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), i.timeoutMs);
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
          const body = (await res.json()) as Candle[] | { error: string };
          if (!Array.isArray(body)) throw new Error(`indexer: ${(body as any).error ?? 'bad payload'}`);
          return body;
        } finally {
          clearTimeout(timer);
        }
      },
      { attempts: 3, baseDelayMs: 500 },
    );

    // Newest candle is "current"; everything before it forms the baseline, so a
    // spike cannot raise the median it is being compared against.
    const sorted = [...candles].sort((a, b) => a.intervalStart - b.intervalStart);
    const vols = sorted.map(parkinson).filter((v): v is number => v !== undefined);
    if (vols.length < 24) {
      log(`  ! indexer returned only ${vols.length} usable candles — vol baseline unavailable`);
      return undefined;
    }

    const current = vols[vols.length - 1];
    const base = median(vols.slice(0, -1));
    if (base === undefined || !(base > 0)) return undefined;

    return { current, median: base, samples: vols.length };
  } catch (e: any) {
    // Deliberately non-fatal: the keeper keeps running on its feed-based triggers.
    log(`  ! vol baseline unavailable (${e?.message ?? e}) — falling back to feed-move triggers`);
    return undefined;
  }
}
