import type { VaultV1 } from './types';

// the fleet cells, in one place: the server text screens (contract/text.ts) and
// the page (src/lib/utils/text.js) render the same words from the same numbers,
// so `/api/v1/status.txt` and `/` can never disagree about a cell. pure, no dom,
// no db — the page imports this module, never the other way round (the runtime
// image ships server/ without src/).

type Loose = VaultV1 | null | undefined;
type KeeperSide = NonNullable<VaultV1['keeper']> | null | undefined;

// 2s / 34m / 2h04m / 2d3h
export function fmtAge(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || !Number.isFinite(secs)) return '-';
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h${String(m).padStart(2, '0')}m`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h ? `${d}d${h}h` : `${d}d`;
}

const KIND_ABBR: Readonly<Record<string, string>> = { recenter: 'rec', refresh: 'ref', fold: 'fold', compound: 'cmp', unknown: 'tx' };

export function kindAbbr(kind: string | null | undefined): string {
  return KIND_ABBR[kind ?? ''] ?? kind ?? '-';
}

// winning trigger word + dwell: `TRIGGER` when armed, `fold 12m` while the dwell counts, `-`
export function armedWord(keeper: KeeperSide): string {
  const d = keeper?.dwell;
  if (!d) return keeper?.action ?? '-';
  const legs = [
    ['rebalance', 'TRIGGER', 'trigger'],
    ['refresh', 'REFRESH', 'refresh'],
    ['fold', 'FOLD', 'fold'],
  ] as const;
  for (const [k, up] of legs) if (d[k]?.armed) return up;
  for (const [k, , low] of legs) {
    const leg = d[k];
    if (leg && leg.sinceTs > 0 && leg.heldSecs > 0 && !leg.armed) return `${low} ${fmtAge(leg.heldSecs)}`;
  }
  return '-';
}

const GATE_WORD: Readonly<Record<string, string>> = {
  'twap-history': 'twap hist',
  'twap-dev': 'twap',
  'twap-unavailable': 'twap n/a',
  'spot-unsafe': 'spot unsafe',
  'oracle-stale': 'oracle stale',
  'oracle-dev': 'clamp',
  'oracle-unreadable': 'oracle n/a',
};

// the fleet `blocking` cell: gate code + reading>limit, or the exit that stopped due work
export function blockingWord(v: Loose): string {
  const k = v?.keeper;
  const code = k?.standing?.code ?? k?.outcome?.code;
  if (!code) return '-';
  const g = k?.gateSaw;
  switch (code) {
    case 'gate-blocked': {
      const sub = g?.failedAt ?? k?.standing?.subcode ?? null;
      const word = GATE_WORD[sub ?? ''] ?? 'gate';
      if (sub === 'oracle-dev' && g?.oracle) return `${word} ${g.oracle.devTicks}>${g.oracle.maxDevTicks}`;
      if (sub === 'twap-dev' && g?.twap) return `${word} ${g.twap.devTicks}>${g.twap.maxDevTicks}`;
      if (sub === 'oracle-stale' && g?.oracle) return `${word} ${fmtAge(g.oracle.ageSecs)}`;
      return word;
    }
    case 'cooldown': {
      const c = k?.cooldown;
      const left = c && c.minIntervalSecs !== null && c.elapsedSecs !== null ? c.minIntervalSecs - c.elapsedSecs : null;
      return left !== null ? `cooldown ${fmtAge(left)}` : 'cooldown';
    }
    case 'regime-extreme':
      return 'regime EXTREME';
    case 'gas-floor':
      return 'gas floor';
    case 'clamp-unworkable':
      return 'clamp n/a';
    case 'width-cap':
      return 'width cap';
    case 'preflight-revert':
      return 'preflight';
    case 'dry-run':
      return 'DRY';
    case 'error':
      return 'error';
    case 'no-regime-feed-unreadable':
      return 'feed n/a';
    default:
      return '-';
  }
}

// `2d rec`: age + kind of the last landed tx
export function lastActWord(v: Loose, nowTs: number): string {
  const tx = v?.keeper?.lastTx;
  if (!tx) return '-';
  const age = tx.ts === null || tx.ts === undefined ? '?' : fmtAge(Math.max(0, nowTs - tx.ts));
  return `${age} ${kindAbbr(tx.kind)}`;
}

// the `blk` cell: that vault's last cycle ok/err; `-` when the keeper is not reachable
export function blkWord(v: Loose): string {
  const k = v?.keeper;
  if (!k?.reachable) return '-';
  return k.outcome?.code === 'error' ? 'err' : 'ok';
}
