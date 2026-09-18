// text helpers for the screens. everything here returns strings the vendored DOS font can
// draw (server/contract/glyphs.ts is the whitelist); keeper-grammar text goes through
// mapGlyphs at render time only. widths are cells: the box art is 78, rulers and bars are
// sized by the caller.
import { mapGlyphs } from '../../../server/contract/glyphs';
// the fleet cells live in the server contract so both renderers draw the same words
import { armedWord, blkWord, blockingWord, fmtAge, kindAbbr, lastActWord as lastActWordAt } from '../../../server/contract/cells';

export const WIDTH = 78;
export const GLYPH = { left: '├', right: '┤', line: '─', base: '▓', limit: '░', spot: '■', full: '█', empty: '░', inRange: '▒', out: '░' };

export { mapGlyphs, armedWord, blkWord, blockingWord, fmtAge, kindAbbr };

// --- strings ----------------------------------------------------------------

export function pad(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function padLeft(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

// exactly n cells: pad, or cut with `..`
export function fit(s, n) {
  s = String(s ?? '');
  if (s.length <= n) return pad(s, n);
  return n <= 2 ? s.slice(0, n) : s.slice(0, n - 2) + '..';
}

// one screen line: joined columns, padded to WIDTH
export function line(...parts) {
  return fit(parts.join(''), WIDTH);
}

// label slug for /v/<id>: 'aDOT/HOLLAR' -> 'adot-hollar'
export function slugOf(label) {
  return String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// --- numbers ------------------------------------------------------------------

const groups = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  return groups.format(Math.trunc(Number(n)));
}

export const fmtBlock = fmtNum;

export function fmtTick(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  return String(Math.trunc(Number(n)));
}

// the number part of an amount: 4,242 / 12.3 / 3.12 / 0.00172 / 4.9e-6
export function fmtHuman(x, { digits = 3 } = {}) {
  if (x == null || !Number.isFinite(Number(x))) return '-';
  x = Number(x);
  const a = Math.abs(x);
  if (a === 0) return '0';
  if (a >= 1000) return groups.format(Math.round(x));
  if (a >= 100) return x.toFixed(0);
  if (a >= 1) return x.toFixed(2).replace(/\.?0+$/, '');
  if (a < 1e-4) return x.toExponential(1);
  return Number(x.toPrecision(digits)).toString();
}

export function fmtToken(amount) {
  if (!amount) return '-';
  return `${fmtHuman(amount.human)} ${amount.symbol ?? ''}`.trim();
}

export function weiToNumber(wei, decimals = 18) {
  if (wei == null) return null;
  const s = String(wei);
  if (!/^\d+$/.test(s)) return null;
  const whole = s.length > decimals ? s.slice(0, s.length - decimals) : '0';
  const frac = s.padStart(decimals + 1, '0').slice(-decimals);
  return Number(`${whole}.${frac}`);
}

export function fmtWei(wei, { decimals = 18, symbol = 'WETH' } = {}) {
  const n = weiToNumber(wei, decimals);
  if (n == null) return '-';
  return `${fmtHuman(n)} ${symbol}`.trim();
}

export function fmtPct(frac, { signed = false, digits = 1 } = {}) {
  if (frac == null || !Number.isFinite(Number(frac))) return '-';
  const v = Number(frac) * 100;
  const s = v.toFixed(digits);
  return signed && v > 0 ? `+${s}%` : `${s}%`;
}

export function fmtMult(x) {
  if (x == null || !Number.isFinite(Number(x))) return '-';
  return `${Number(x).toFixed(1)}x`;
}

// --- addresses ------------------------------------------------------------------

export function shortAddr(a) {
  if (!a || a.length < 12) return a ?? '-';
  return `${a.slice(0, 6)}..${a.slice(-4)}`;
}

export function shortHash(h) {
  if (!h || h.length < 10) return h ?? '-';
  return `${h.slice(0, 6)}..${h.slice(-2)}`;
}

export function hash4(h) {
  return h && h.length > 6 ? h.slice(2, 6) : '-';
}

// --- time ------------------------------------------------------------------------

export function toSecs(t) {
  if (t == null) return null;
  if (typeof t === 'number') return t > 1e12 ? Math.floor(t / 1000) : Math.floor(t);
  const ms = new Date(t).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function nowSecs(now) {
  return toSecs(now ?? Date.now());
}

export function ageOf(ts, now) {
  const t = toSecs(ts);
  return t == null ? null : Math.max(0, nowSecs(now) - t);
}

// 'in 34m' / 'due' / '-'
export function fmtDueIn(secs) {
  if (secs == null) return '-';
  return secs <= 0 ? 'due' : `in ${fmtAge(secs)}`;
}

export function fmtClock(ts) {
  const t = toSecs(ts);
  return t == null ? '-' : new Date(t * 1000).toISOString().slice(11, 16);
}

export function fmtClockS(ts) {
  const t = toSecs(ts);
  return t == null ? '-' : new Date(t * 1000).toISOString().slice(11, 19);
}

export function fmtDate(ts) {
  const t = toSecs(ts);
  return t == null ? '-' : new Date(t * 1000).toISOString().slice(0, 10);
}

// HH:MM:SS today, MM-DD HH:MM otherwise (utc)
export function fmtWhen(ts, now) {
  const t = toSecs(ts);
  if (t == null) return '-';
  const iso = new Date(t * 1000).toISOString();
  const today = new Date(nowSecs(now) * 1000).toISOString().slice(0, 10);
  return iso.slice(0, 10) === today ? iso.slice(11, 19) : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

// --- bars, strips, rulers ---------------------------------------------------------

// reading/limit capped at 100%: ███████░░░ ; null -> ──────────
export function bar(ratio, cells = 10) {
  if (ratio == null || !Number.isFinite(ratio)) return GLYPH.line.repeat(cells);
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * cells);
  return GLYPH.full.repeat(filled) + GLYPH.empty.repeat(cells - filled);
}

// booleans (in range?) resampled to cells: ▒ in, ░ out, space unknown
export function strip(flags, cells) {
  if (!Array.isArray(flags) || flags.length === 0) return ' '.repeat(cells);
  const out = [];
  for (let i = 0; i < cells; i += 1) {
    const from = Math.floor((i * flags.length) / cells);
    const to = Math.max(from + 1, Math.floor(((i + 1) * flags.length) / cells));
    let yes = 0;
    let known = 0;
    for (let j = from; j < to; j += 1) {
      if (flags[j] == null) continue;
      known += 1;
      if (flags[j]) yes += 1;
    }
    out.push(known === 0 ? ' ' : yes * 2 >= known ? GLYPH.inRange : GLYPH.out);
  }
  return out.join('');
}

function place(chars, at, text) {
  for (let i = 0; i < text.length; i += 1) {
    const k = at + i;
    if (k < 0 || k >= chars.length) return false;
    if (chars[k] !== ' ') return false;
  }
  for (let i = 0; i < text.length; i += 1) chars[at + i] = text[i];
  return true;
}

// the band ruler. span = base padded by a third of its width, stretched to keep spot, twap,
// oracle and the limit on screen. ▓ base, ░ limit, ■ spot, ─ outside; markers t o m under it
export function ruler({ lower, upper, spot, twap = null, oracle = null, mid = null, limit = null, limitLiquidity = null, cells = 78 }) {
  const w = Math.max(6, cells - 2);
  const width = Math.max(1, upper - lower);
  const m = Math.ceil(width / 3);
  const points = [spot, twap, oracle, ...(limit ?? [])].filter((x) => x != null && Number.isFinite(x));
  const lo = Math.min(lower - m, ...points.map((p) => p - Math.ceil(m / 4)));
  const hi = Math.max(upper + m, ...points.map((p) => p + Math.ceil(m / 4)));
  const pos = (t) => Math.min(w - 1, Math.max(0, Math.round(((t - lo) / (hi - lo)) * (w - 1))));
  const tickAt = (i) => lo + (i * (hi - lo)) / (w - 1);
  const hasLimit = limit && limit.length === 2 && (limitLiquidity == null || limitLiquidity !== '0');

  const body = [];
  for (let i = 0; i < w; i += 1) {
    const t = tickAt(i);
    if (hasLimit && t >= limit[0] && t <= limit[1]) body.push(GLYPH.limit);
    else if (t >= lower && t <= upper) body.push(GLYPH.base);
    else body.push(GLYPH.line);
  }
  if (hasLimit) {
    // a thin limit still shows as one cell
    const a = pos(limit[0]);
    if (body[a] !== GLYPH.limit) body[a] = GLYPH.limit;
  }
  const inBand = spot != null && spot >= lower && spot <= upper;
  if (spot != null && Number.isFinite(spot)) body[pos(spot)] = GLYPH.spot;

  // markers: base edges first, then the limit label, then t o m where free
  const marks = Array(w + 2).fill(' ');
  place(marks, pos(lower) + 1, `^ ${lower}`);
  const up = `^ ${upper}`;
  place(marks, Math.min(w + 2 - up.length, pos(upper) + 1), up);
  if (hasLimit) {
    const at = pos(limit[0]) + 1;
    if (!place(marks, at, `${GLYPH.limit} limit`)) place(marks, at, GLYPH.limit);
  }
  for (const [t, ch] of [
    [twap, 't'],
    [oracle, 'o'],
    [mid, 'm'],
  ]) {
    if (t == null || !Number.isFinite(t)) continue;
    const at = pos(t) + 1;
    if (!place(marks, at, ch) && !place(marks, at + 1, ch)) place(marks, at - 1, ch);
  }

  return {
    line: GLYPH.left + body.join('') + GLYPH.right,
    markers: marks.join(''),
    span: [Math.round(lo), Math.round(hi)],
    spotAt: spot != null ? pos(spot) + 1 : null,
    inBand,
  };
}

// the fleet band cell: brackets are the base edges, ■ spot, t twap, o oracle. spot outside the
// band takes the bracket on its side
export function miniRuler({ lower, upper, spot, twap = null, oracle = null, cells = 10 }) {
  const w = Math.max(4, cells - 2);
  const span = Math.max(1, upper - lower);
  const inner = (t) => Math.min(w - 1, Math.max(0, Math.round(((t - lower) / span) * (w - 1))));
  const body = Array(w).fill(GLYPH.line);
  for (const [t, ch] of [
    [twap, 't'],
    [oracle, 'o'],
  ]) {
    if (t != null && Number.isFinite(t) && t >= lower && t <= upper) body[inner(t)] = ch;
  }
  let left = GLYPH.left;
  let right = GLYPH.right;
  const inBand = spot != null && spot >= lower && spot <= upper;
  if (spot != null && Number.isFinite(spot)) {
    if (spot < lower) left = GLYPH.spot;
    else if (spot > upper) right = GLYPH.spot;
    else body[inner(spot)] = GLYPH.spot;
  }
  return { line: left + body.join('') + right, inBand };
}

// where spot sits relative to mid, as the phone/agent rendering: 'in +40%' / 'OUT +112%'
export function offMid({ lower, upper, spot }) {
  if (spot == null || upper === lower) return '-';
  const mid = (lower + upper) / 2;
  const half = (upper - lower) / 2;
  const frac = (spot - mid) / half;
  const inBand = spot >= lower && spot <= upper;
  return `${inBand ? 'in' : 'OUT'} ${fmtPct(frac, { signed: true, digits: 0 })}`;
}

// --- vault derivations shared by the screens ---------------------------------------

// `2d rec`: age + kind of the last landed tx (`now` here is whatever the screens carry)
export function lastActWord(v, now) {
  return lastActWordAt(v, nowSecs(now));
}

export const LEVEL_RANK = { fault: 3, held: 2, unknown: 1, ok: 0 };
export const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

// the fleet footer: one line per vault (its verdict sentence) + every active global finding,
// worst first; `!` marks anything that is not quiet
export function footerLines(status, now) {
  if (!status) return [];
  const rows = [];
  for (const v of status.vaults ?? []) {
    const level = v.verdict?.level ?? 'unknown';
    rows.push({
      rank: LEVEL_RANK[level] ?? 1,
      cls: level,
      label: v.label,
      vault: v.id,
      text: mapGlyphs(v.verdict?.sentence ?? ''),
    });
  }
  for (const f of status.findings ?? []) {
    if (!f.active || f.vault != null) continue;
    const age = ageOf(f.onsetAt, now);
    rows.push({
      rank: (SEVERITY_RANK[f.severity] ?? 1) + (f.stale ? 0 : 0.5),
      cls: f.severity === 'critical' ? 'fault' : f.severity === 'warning' ? 'held' : 'ok',
      stale: f.stale,
      label: 'chain',
      vault: null,
      text: mapGlyphs(`${f.key} firing ${fmtAge(age)}  ${f.detail ?? f.title ?? ''}`.trim()),
    });
  }
  rows.sort((a, b) => b.rank - a.rank);
  return rows.map((r) => ({ ...r, mark: r.cls === 'ok' ? ' ' : '!' }));
}

// quiet / due / blocked for the status bar
export function summarize(vaults) {
  const s = { quiet: 0, due: 0, blocked: 0 };
  for (const v of vaults ?? []) {
    const l = v.liveness;
    if (l === 'due' || l === 'acting') s.due += 1;
    else if (v.verdict?.level === 'ok' || l === 'alive' || l === 'quiet') s.quiet += 1;
    else s.blocked += 1;
  }
  return s;
}

// the host label in the title: gamma.play.hydration.cloud -> play
export function envOf(hostname) {
  if (!hostname) return '';
  const parts = hostname.split('.');
  if (parts.length >= 3 && parts[0] === 'gamma') return parts[1];
  return parts[0] === 'localhost' || /^\d+\.\d+/.test(hostname) ? 'dev' : parts[0];
}

// --- art-free text renderings (?agent=1 and the ssr fallback): exactly WIDTH per line ----

function livenessWord(k, now) {
  switch (k?.liveness) {
    case 'stalled':
      return `STALLED ${fmtAge(k.head?.at ? ageOf(k.head.at, now) : null)}`;
    case 'unreachable':
      return 'keeper unreachable';
    case 'restarted':
      return `restarted ${fmtAge(ageOf(k.bootAt, now))} ago`;
    default:
      return k?.liveness ?? (k?.configured ? 'unknown' : 'not configured');
  }
}

export function headerLines(status, { now, env = '' } = {}) {
  if (!status) return [line('gamma keeper  ', env, '  connecting..')];
  const k = status.keeper ?? {};
  const n = status.vaults?.length ?? 0;
  const mode = k.mode === 'DRY_RUN' ? 'DRY' : k.mode ?? '-';
  const firing = (status.findings ?? []).filter((f) => f.active && f.source === 'monitor').length;
  const agree = (status.vaults ?? []).filter((v) => (v.disagreements?.length ?? 0) === 0).length;
  const head = status.sources?.chain?.head;
  const gas = k.gas;
  const mon = status.sources?.monitor;
  return [
    line(`gamma keeper  ${env ? env + '  ' : ''}${n} vault${n === 1 ? '' : 's'}  signer ${shortAddr(k.signer)}  ${mode}  ${k.version ? 'v' + k.version : ''}`),
    line(
      `${pad(livenessWord(k, now), 7)} block ${fmtBlock(k.head?.number)} (${fmtAge(k.head?.at ? ageOf(k.head.at, now) : null)})  cycles ${fmtNum(k.cyclesTotal)}  errors ${fmtNum(k.errorsTotal)}  skipped ${fmtNum(k.skippedWhileBusy)}  up ${fmtAge(ageOf(k.bootAt, now))}`,
    ),
    line(
      `gas     ${gas ? fmtWei(gas.signerBalanceWei) : '-'}  runway ${gas?.runwayDays != null ? Math.floor(gas.runwayDays) + 'd' : '-'}   warn ${gas ? fmtHuman(weiToNumber(gas.warnWei)) : '-'}  floor ${gas ? fmtHuman(weiToNumber(gas.floorWei)) : '-'}`,
    ),
    line(
      `chain   monitor ${mon?.configured ? (mon.reachable ? fmtAge(mon.ageSecs) + ' ago' : 'unreachable') : 'not configured'}  ${firing} firing   agree ${agree}/${n}   rpc #${fmtBlock(head?.number)} (${fmtAge(head?.at ? ageOf(head.at, now) : null)})`,
    ),
  ];
}

export function fleetRows(status, now) {
  return (status?.vaults ?? []).map((v) => {
    const c = v.chain;
    const band = c ? offMid({ lower: c.base.lower, upper: c.base.upper, spot: c.spotTick }) : '-';
    return {
      id: v.id,
      slug: slugOf(v.label),
      label: v.label,
      blk: blkWord(v),
      band,
      inBand: c?.base?.inRange ?? null,
      armed: armedWord(v.keeper),
      blocking: blockingWord(v),
      last: lastActWord(v, now),
      chain: c ? `#${fmtBlock(c.asOf?.block)} (${fmtAge(c.ageSecs)})` : '-',
      level: v.verdict?.level ?? 'unknown',
      liveness: v.liveness,
    };
  });
}

export function fleetText(status, { now, env = '' } = {}) {
  const out = headerLines(status, { now, env });
  if (!status) return out;
  out.push(line(pad('vault', 14), pad('blk', 5), pad('band', 10), pad('armed', 12), pad('blocking', 15), 'last'));
  for (const r of fleetRows(status, now)) {
    out.push(line(fit(r.label, 13), ' ', pad(r.blk, 5), pad(r.band, 10), fit(r.armed, 11), ' ', fit(r.blocking, 14), ' ', r.last));
  }
  for (const f of footerLines(status, now)) out.push(line(f.mark, ' ', fit(f.label, 13), '  ', f.text));
  return out;
}

export function vaultText(v, status, { now } = {}) {
  if (!v) return [line('vault not found')];
  const c = v.chain;
  const k = v.keeper ?? {};
  const out = [];
  out.push(line(`${v.label}  ${shortAddr(v.id)}  ${v.entrypoint}  ${(k.regime?.regime ?? '-').toUpperCase()}`));
  if (c) {
    out.push(line(`spot ${fmtTick(c.spotTick)}  base ${c.base.lower}-${c.base.upper}  ${offMid({ lower: c.base.lower, upper: c.base.upper, spot: c.spotTick })}  drift ${c.base.driftTicks}${c.base.thresholdTicks != null ? ' > ' + c.base.thresholdTicks : ''}  price ${fmtHuman(c.price?.human)}`));
    out.push(line(`limit ${c.limit.lower}-${c.limit.upper}  ${c.limit.outsideByTicks} ${c.limit.side ?? ''}  liquidity ${c.limit.liquidity === '0' ? 'none' : 'yes'}`));
  } else {
    out.push(line('chain   no sample yet'));
  }
  out.push(line(`keeper  ${k.reachable ? 'block ' + fmtBlock(k.asOf?.block) + ' (' + fmtAge(k.ageSecs) + ')' : 'unreachable'}`));
  out.push(line(`trigger ${pad(armedWord(k), 10)} ${mapGlyphs(k.outcome?.detail ?? '')}`));
  const cd = k.cooldown;
  out.push(line(`cooldown ${cd ? (cd.skipped ? 'HELD' : 'ok') + '  last ' + fmtAge(cd.elapsedSecs) + ' ago  (min ' + fmtAge(cd.minIntervalSecs) + ')' : '-'}`));
  const g = k.gateSaw;
  out.push(line(`gate    ${g ? (g.ok ? 'ok' : 'BLOCKED') + '  ' + mapGlyphs(g.reason ?? '') : '-'}`));
  const r = k.regime;
  out.push(line(`regime  ${r ? r.regime.toUpperCase() + '  vol ' + fmtMult(r.inputs?.volRatio) + '  eval ' + fmtClock(r.lastEvaluatedAt) : '-'}`));
  const gas = status?.keeper?.gas;
  out.push(line(`gas     ${gas ? fmtWei(gas.signerBalanceWei) + ' >= ' + fmtHuman(weiToNumber(gas.floorWei)) + ' floor' : '-'}`));
  const cp = k.compound;
  out.push(line(`compound ${cp ? fmtDueIn(cp.dueInSecs) : '-'}${c?.feesOwed ? '  owed ' + fmtToken(c.feesOwed.fees0) + ' + ' + fmtToken(c.feesOwed.fees1) : ''}`));
  out.push(line(`verdict ${(v.verdict?.level ?? '-').toUpperCase()}  ${mapGlyphs(v.verdict?.sentence ?? '')}`));
  if (c) {
    out.push(line(`nav ${fmtHuman(c.nav.navToken1)} ${c.nav.total1.symbol}  X ${fmtPct(c.composition.token0Share)} ${c.nav.total0.symbol}  base ${fmtPct(c.composition.baseShare)}  limit ${fmtPct(c.composition.limitShare)}  2X-1 ${fmtPct(c.composition.twoXMinusOne)}`));
    out.push(line(`last act ${lastActWord(v, now)} ${k.lastTx ? shortHash(k.lastTx.hash) : ''}  deposits ${c.deposits.state}  shares ${fmtHuman(weiToNumber(c.shares.totalSupply))}`));
  }
  for (const f of v.monitor?.firing ?? []) out.push(line(`! ${f.key}  ${mapGlyphs(f.detail ?? f.title ?? '')}`));
  for (const d of v.disagreements ?? []) out.push(line(`! disagree ${d.key}  ${mapGlyphs(d.detail ?? '')}`));
  return out;
}
