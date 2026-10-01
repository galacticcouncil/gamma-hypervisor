import type { StatusV1, VaultDetailV1, VaultV1 } from './types';
import { bar, fit, fmtAddr, fmtClock, fmtDur, fmtDurShort, fmtHash, fmtInt, fmtNum, fmtPct, fmtWei, padRight, width } from './format';
import { mapGlyphs } from './glyphs';
import { armedWord, blkWord, blockingWord, lastActWord } from './cells';

// the fleet and vault screens as text/plain, same data path as the page. every
// emitted line is exactly 78 code points and every dynamic string goes through
// mapGlyphs first (the font has no ✓ ⚠ — …), so mapping can never widen a line
// after it was fitted.

export const WIDTH = 78;

const t = (s: string): string => mapGlyphs(s);

// exactly 78 code points, mapped
export function line(s: string): string {
  return fit(t(s), WIDTH);
}

function rule(ch: string, n: number): string {
  return ch.repeat(n);
}

// single box
const top = (): string => `┌${rule('─', 76)}┐`;
const bottom = (): string => `└${rule('─', 76)}┘`;
const rowIn = (s: string): string => `│${fit(t(` ${s}`), 76)}│`;

// double box (the drill)
const dTop = (title: string, right: string): string => {
  const head = t(`╔═ ${title} `);
  const tail = t(` ${right} ══╗`);
  const fill = Math.max(0, WIDTH - width(head) - width(tail));
  return fit(`${head}${rule('═', fill)}${tail}`, WIDTH);
};
const dBottom = (): string => `╚${rule('═', 76)}╝`;
const dRow = (s: string): string => `║${fit(t(` ${s}`), 76)}║`;
const dSep = (): string => `╟${rule('─', 76)}╢`;

// the keeper-says │ chain-says split: 53 + 1 + 22 = 76
const LEFT = 53;
const RIGHT = 22;
const dSplit = (l: string, r: string): string => `║${fit(t(` ${l}`), LEFT)}│${fit(t(` ${r}`), RIGHT)}║`;
const dSplitHead = (l: string, r: string): string => {
  const left = t(`──────── ${l} `);
  const right = t(`──── ${r} `);
  return `╟${fit(`${left}${rule('─', Math.max(0, LEFT - width(left)))}`, LEFT)}┬${fit(`${right}${rule('─', Math.max(0, RIGHT - width(right)))}`, RIGHT)}╢`;
};

// table rules for the fleet grid
function gridRule(left: string, mid: string, right: string, widths: readonly number[]): string {
  return left + widths.map((w) => rule('─', w)).join(mid) + right;
}
function gridRow(cells: readonly string[], widths: readonly number[]): string {
  return `│${cells.map((c, i) => fit(t(` ${c}`), widths[i])).join('│')}│`;
}

export const MENU = ' ≡ Fleet  Vault  Gates  History  Econ  Config';

export function menuLine(nowMs: number): string {
  const clock = `${fmtClock(new Date(nowMs))} UTC`;
  return line(`${MENU}${' '.repeat(Math.max(1, WIDTH - width(MENU) - width(clock)))}${clock}`);
}

export const FLEET_KEYS = ' F1 Help F2 Fleet F3 Vault F4 Gates F5 Hist F6 Econ F7 Cfg F9 Theme F10 Menu';
export const DRILL_KEYS = ' F1 Help F2 Fleet F4 Gates F5 Hist F6 Econ F7 Cfg  Tab next vault  Esc back';

// the f-key bar is a 78-col line too: hints, then the parked cursor block
export function keyBar(keys: string): string {
  return `${fit(t(keys), WIDTH - 1)}█`;
}

// --- the band ruler ------------------------------------------------------------

export interface RulerMarks {
  spot: number | null;
  twap: number | null;
  oracle: number | null;
  mid: number | null;
}

// `├─────▓▓▓■▓▓▓░░░░───┤` across [lower, upper] widened to hold every mark
export function ruler(lower: number, upper: number, marks: RulerMarks, cells = 70): [string, string] {
  const xs = [lower, upper, marks.spot, marks.twap, marks.oracle, marks.mid].filter((x): x is number => x !== null);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const span = Math.max(1, hi - lo);
  const at = (tick: number): number => Math.max(0, Math.min(cells - 1, Math.round(((tick - lo) / span) * (cells - 1))));
  const body: string[] = [];
  for (let i = 0; i < cells; i++) {
    const tick = lo + (span * i) / (cells - 1);
    body.push(tick >= lower && tick <= upper ? '▓' : '─');
  }
  const labels = new Array<string>(cells).fill(' ');
  const put = (tick: number | null, ch: string): void => {
    if (tick === null) return;
    labels[at(tick)] = ch;
  };
  put(marks.twap, 't');
  put(marks.oracle, 'o');
  put(marks.mid, 'm');
  if (marks.spot !== null) body[at(marks.spot)] = '■';
  return [`├${body.join('')}┤`, ` ${labels.join('')} `];
}

// --- fleet ---------------------------------------------------------------------

const FLEET_WIDTHS = [14, 5, 18, 11, 14, 9] as const;

function fleetHeader(s: StatusV1): string[] {
  const k = s.keeper;
  const head = k.head ? `block ${fmtInt(k.head.number)}` : 'block -';
  const headAge = k.head ? ` (${fmtDurShort(Math.max(0, Math.trunc(Date.parse(s.generatedAt) / 1000) - (k.head.ts ?? 0)))})` : '';
  const gas = k.gas;
  const gasFrac = gas?.signerBalanceWei && gas.warnWei && BigInt(gas.warnWei) > 0n ? Number((BigInt(gas.signerBalanceWei) * 100n) / BigInt(gas.warnWei)) / 100 : null;
  const firing = s.findings.filter((f) => f.active).length;
  const agree = s.vaults.filter((v) => v.disagreements.length === 0).length;
  const chainHead = s.sources.chain.head ? `rpc #${fmtInt(s.sources.chain.head.number)}` : 'rpc -';
  return [
    rowIn(
      `gamma keeper  ${s.vaults.length} vault${s.vaults.length === 1 ? '' : 's'}  signer ${fmtAddr(k.signer)}  ${k.mode ?? 'unknown'}  ${k.version ?? 'v?'}`,
    ),
    rowIn(
      `${padRight(k.configured ? k.liveness : 'not configured', 8)} ${head}${headAge}  cycles ${fmtInt(k.cyclesTotal ?? 0)}  skipped ${fmtInt(k.skippedWhileBusy ?? 0)}  errors ${fmtInt(k.errorsTotal ?? 0)}`,
    ),
    rowIn(
      `gas     ${fmtWei(gas?.signerBalanceWei ?? null)}  ${bar(gasFrac)}  runway ${gas?.runwayDays === null || gas?.runwayDays === undefined ? '-' : `${Math.trunc(gas.runwayDays)}d`}   warn ${fmtWei(gas?.warnWei ?? null)}  floor ${fmtWei(gas?.floorWei ?? null)}`,
    ),
    rowIn(
      `chain   monitor ${s.sources.monitor.ageSecs === null ? '-' : `${fmtDurShort(s.sources.monitor.ageSecs)} ago`}  ${firing} firing   agree ${agree}/${s.vaults.length}   ${chainHead}`,
    ),
  ];
}

function bandCell(v: VaultV1): string {
  const c = v.chain;
  if (!c) return '-';
  const [line1] = ruler(c.base.lower, c.base.upper, { spot: c.spotTick, twap: null, oracle: null, mid: null }, 10);
  return `${c.base.inRange ? 'in ' : 'OUT'} ${line1}`;
}

function footerLines(s: StatusV1): string[] {
  const out: string[] = [];
  for (const f of s.findings.filter((x) => x.active).slice(0, 4)) {
    const who = f.vault ? (s.vaults.find((v) => v.id === f.vault)?.label ?? 'vault') : 'chain';
    out.push(rowIn(`${f.severity === 'info' ? ' ' : '!'} ${padRight(who, 13)} ${f.title}${f.detail ? `  ${f.detail}` : ''}`));
  }
  for (const v of s.vaults) {
    if (out.length >= 6) break;
    if (v.verdict.level !== 'ok') continue;
    out.push(rowIn(`  ${padRight(v.label, 13)} ${v.verdict.sentence}`));
  }
  if (out.length === 0) out.push(rowIn('  nothing firing'));
  return out;
}

export function renderFleet(s: StatusV1, o: { nowMs?: number } = {}): string {
  const nowMs = o.nowMs ?? (Date.parse(s.generatedAt) || Date.now());
  const lines: string[] = [menuLine(nowMs), top(), ...fleetHeader(s)];
  lines.push(gridRule('├', '┬', '┤', FLEET_WIDTHS));
  lines.push(gridRow(['vault', 'blk', 'band', 'armed', 'blocking', 'last'], FLEET_WIDTHS));
  lines.push(gridRule('├', '┼', '┤', FLEET_WIDTHS));
  const nowTs = Math.trunc(nowMs / 1000);
  for (const v of s.vaults) {
    lines.push(gridRow([v.label, blkWord(v), bandCell(v), armedWord(v.keeper), blockingWord(v), lastActWord(v, nowTs)], FLEET_WIDTHS));
  }
  if (s.vaults.length === 0) lines.push(gridRow(['no vaults', '-', '-', '-', '-', '-'], FLEET_WIDTHS));
  lines.push(gridRule('├', '┴', '┤', FLEET_WIDTHS));
  lines.push(...footerLines(s));
  lines.push(bottom());
  lines.push(keyBar(FLEET_KEYS));
  return lines.map((l) => fit(l, WIDTH)).join('\n');
}

// --- vault drill ------------------------------------------------------------------

// the right column is the monitor's finding set, keyed on its own vocabulary
// and labelled short enough for 22 columns
const CHAIN_LABEL: Readonly<Record<string, string>> = {
  'out-of-band': 'out-of-band',
  'rebalance-overdue': 'overdue',
  'limit-stranded': 'stranded',
  'clamp-blocking': 'clamp-blocking',
  paused: 'paused',
  gas: 'gas',
  'gas-warn': 'gas-warn',
  divergence: 'divergence',
  'feed-stale': 'feed-stale',
};

function chainCell(v: VaultV1, key: string): string {
  const label = CHAIN_LABEL[key] ?? key;
  const f = v.monitor.firing.find((x) => x.key === key);
  const mark = f ? (f.severity === 'critical' ? '!!' : '!') : v.monitor.reachable ? 'no' : '-';
  return `${padRight(label, 15)} ${mark}`;
}

export function renderVault(d: VaultDetailV1, o: { index?: number; total?: number; nowMs?: number } = {}): string {
  const v = d.vault;
  const c = v.chain;
  const k = v.keeper;
  const nowMs = o.nowMs ?? (Date.parse(d.generatedAt) || Date.now());
  const nowTs = Math.trunc(nowMs / 1000);
  const pos = o.total && o.total > 1 ? `${o.index ?? 1} of ${o.total} »` : '1 of 1';
  const regime = k.regime?.regime ?? 'unknown';
  const lines: string[] = [menuLine(nowMs)];
  lines.push(dTop(`${v.label}  ${fmtAddr(v.id)}  ${v.entrypoint}  ${regime.toUpperCase()}`, pos));

  if (c) {
    const lo = Math.min(c.base.lower, c.limit.lower, c.spotTick);
    const hi = Math.max(c.base.upper, c.limit.upper, c.spotTick);
    const mid = Math.round((c.base.lower + c.base.upper) / 2);
    const [rulerLine, markLine] = ruler(
      c.base.lower,
      c.base.upper,
      { spot: c.spotTick, twap: k.gateSaw?.twap?.tick ?? null, oracle: k.gateSaw?.oracle?.tick ?? null, mid },
      70,
    );
    const head = `ticks ${fmtInt(lo)}`;
    lines.push(dRow(`${head}${' '.repeat(Math.max(1, 74 - width(head) - width(fmtInt(hi))))}${fmtInt(hi)}`));
    lines.push(dRow(rulerLine));
    lines.push(dRow(markLine));
    lines.push(dRow(`spot ${fmtInt(c.spotTick)}  price ${fmtNum(c.price.human, 4)}  ${c.price.quote}`));
    lines.push(
      dRow(
        `drift ${fmtInt(c.base.driftTicks)} > ${c.base.thresholdTicks === null ? '-' : fmtInt(c.base.thresholdTicks)}   ${c.base.inRange ? 'in band' : 'OUT of band'}   limit ${fmtInt(c.limit.lower)}-${fmtInt(c.limit.upper)}  ${fmtInt(c.limit.outsideByTicks)} away`,
      ),
    );
  } else {
    lines.push(dRow('chain  no sample yet'));
  }

  const blockLabel = k.asOf ? `block ${fmtInt(k.asOf.block)} (${fmtDurShort(k.ageSecs ?? 0)})` : 'no cycle yet';
  lines.push(dSplitHead(`keeper says  ${blockLabel}`, 'chain says'));
  const dwell = k.dwell;
  const rec = d.cycles.length ? d.cycles[d.cycles.length - 1].record : null;
  const leg = (name: 'rebalance' | 'refresh' | 'fold'): string => {
    if (!dwell) return '-';
    const l = dwell[name];
    return `${bar(l.requiredSecs > 0 ? l.heldSecs / l.requiredSecs : null, 6)} ${fmtDur(l.heldSecs)}/${fmtDur(l.requiredSecs)}`;
  };
  const word = (name: 'rebalance' | 'refresh' | 'fold'): string =>
    dwell?.[name].armed ? (name === 'rebalance' ? 'TRIGGER' : name === 'refresh' ? 'REFRESH' : 'FOLD') : '-';
  lines.push(
    dSplit(
      `trigger  ${padRight(word('rebalance'), 8)} ${fit(rec?.triggers?.rebalance.reason ?? '-', 16)} ${leg('rebalance')}`,
      `monitor ${v.monitor.ageSecs === null ? '-' : `${fmtDurShort(v.monitor.ageSecs)} ago`}`,
    ),
  );
  lines.push(
    dSplit(`refresh  ${padRight(word('refresh'), 8)} ${fit(rec?.triggers?.refresh.reason ?? '-', 16)} ${leg('refresh')}`, chainCell(v, 'out-of-band')),
  );
  lines.push(dSplit(`fold     ${padRight(word('fold'), 8)} ${fit(rec?.triggers?.fold.reason ?? '-', 16)} ${leg('fold')}`, chainCell(v, 'rebalance-overdue')));
  const cd = k.cooldown;
  lines.push(
    dSplit(
      `cooldown ${padRight(cd ? (cd.skipped ? 'BLOCKED' : 'ok') : '-', 8)} ${cd?.elapsedSecs == null ? '-' : `last ${fmtDur(cd.elapsedSecs)} ago`}  (min ${cd?.minIntervalSecs == null ? '-' : fmtDur(cd.minIntervalSecs)})`,
      chainCell(v, 'limit-stranded'),
    ),
  );
  const gate = k.gateSaw;
  lines.push(
    dSplit(`gate     ${padRight(gate ? (gate.ok ? 'ok' : 'BLOCKED') : '-', 8)} ${gate?.reason ?? '-'}`, chainCell(v, 'clamp-blocking')),
  );
  lines.push(
    dSplit(
      `regime   ${padRight(regime.toUpperCase(), 8)} ${k.regime?.sinceTs ? `since ${fmtDur(Math.max(0, nowTs - k.regime.sinceTs))} ago` : '-'}${k.regime?.inputs.move1hFrac === null || k.regime === null ? '' : `  move1h ${(k.regime.inputs.move1hFrac * 100).toFixed(1)}%`}`,
      chainCell(v, 'paused'),
    ),
  );
  const gas = c?.gas ?? null;
  lines.push(
    dSplit(
      `gas      ${padRight(gas && gas.signerBalanceWei && gas.floorWei ? (BigInt(gas.signerBalanceWei) >= BigInt(gas.floorWei) ? 'ok' : 'LOW') : '-', 8)} ${fmtWei(gas?.signerBalanceWei ?? null)} >= ${fmtWei(gas?.floorWei ?? null)} floor`,
      chainCell(v, 'gas'),
    ),
  );
  const comp = k.compound;
  lines.push(
    dSplit(
      `compound ${comp?.due ? 'due' : comp?.dueInSecs === null || comp === null ? '-' : `in ${fmtDur(comp.dueInSecs)}`}   ${c?.feesOwed ? `owed ${fmtNum(c.feesOwed.fees0.human, 2)} ${c.feesOwed.fees0.symbol} + ${fmtNum(c.feesOwed.fees1.human, 2)} ${c.feesOwed.fees1.symbol}` : ''}`,
      chainCell(v, 'divergence'),
    ),
  );
  lines.push(dRow(`verdict  ${v.verdict.level.toUpperCase()}  ${v.verdict.sentence}`));
  lines.push(dSep());

  if (c) {
    lines.push(
      dRow(
        `nav ${fmtNum(c.nav.navToken1, 0)} ${c.nav.total1.symbol}  X ${fmtPct(c.composition.token0Share, 1, false)} ${c.nav.total0.symbol}  base ${fmtPct(c.composition.baseShare, 1, false)} ${bar(c.composition.baseShare)} limit ${fmtPct(c.composition.limitShare, 1, false)}`,
      ),
    );
    lines.push(
      dRow(
        `last act ${k.lastTx ? `${fmtDurShort(Math.max(0, nowTs - (k.lastTx.ts ?? nowTs)))} ${k.lastTx.kind} ${fmtHash(k.lastTx.hash)}` : '-'}  deposits ${c.deposits.state}  shares ${fmtNum(Number(c.shares.totalSupply) / 1e18, 0)}`,
      ),
    );
  } else {
    lines.push(dRow('nav -'));
    lines.push(dRow(`last act ${k.lastTx ? `${k.lastTx.kind} ${fmtHash(k.lastTx.hash)}` : '-'}`));
  }
  lines.push(dBottom());
  lines.push(keyBar(DRILL_KEYS));
  return lines.map((l) => fit(l, WIDTH)).join('\n');
}

// every line of a rendered screen, for the width + glyph test
export function linesOf(screen: string): string[] {
  return screen.split('\n');
}
