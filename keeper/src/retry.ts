/** Sleep, but resolve immediately for a zero/negative delay. */
const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/**
 * Retry a call a few times with exponential backoff.
 *
 * For reads whose failure is a nuisance rather than a decision — a flaky RPC or
 * a slow indexer. NEVER wrap a rebalance in this: a retried write is a second
 * transaction, and the gates upstream of it were evaluated against older state.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; onRetry?: (attempt: number, err: unknown) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 300;

  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts) break;
      opts.onRetry?.(i, err);
      await sleep(base * 2 ** (i - 1));
    }
  }
  throw lastErr;
}
