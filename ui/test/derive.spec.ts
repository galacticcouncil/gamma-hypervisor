import { describe, expect, it } from 'vitest';
import {
  actionsByKind,
  basketHodl,
  basketPerShare,
  burnPerDay,
  cadence,
  composition,
  compositionFromX,
  costPerTx,
  economicsWindow,
  feesRetained,
  gasRunway,
  hodl5050,
  nav1,
  nav1Incl,
  POLICY_CAP_PER_DAY,
  priceHuman,
  priceRaw,
  sharePrice,
  spAt,
  timeInRange,
  type Decimals,
  type EconPoint,
  type RangeSample,
  type TxLite,
  type ZeroBurnEv,
} from '../server/derive/economics';
import { armedAction, isDue, livenessFor, standingV1, worstLiveness } from '../server/derive/standing';
import { gateName, twapLagHint, verdictFor } from '../server/derive/verdict';
import { stepEpisode } from '../server/derive/episodes';
import { cycleRecord, NOW } from './fixtures';

// the formulas, on fixtures: the wiki §7.1 composition table and a 9-day window
// that reproduces −4.35% vs the deposited basket, +3.3% fees, −7.65% residual.

const D: Decimals = { d0: 10, d1: 18 };

// tick for a human price P (token1 per token0) at these decimals
function tickFor(P: number, d: Decimals): number {
  return Math.round(Math.log(P * Math.pow(10, d.d1 - d.d0)) / Math.log(1.0001));
}

describe('price and nav', () => {
  it('prices a tick raw and human, token1 per token0', () => {
    expect(priceRaw(0)).toBe(1);
    const tick = tickFor(1.09, D);
    expect(priceHuman(tick, D)).toBeCloseTo(1.09, 4);
    expect(priceRaw(tick) / 1e8).toBeCloseTo(1.09, 4);
  });

  it('nav excludes fees until they are added, and share price follows', () => {
    const P = 1;
    const nav = nav1(5_000_000_000n, 500n * 10n ** 18n, P, D); // 0.5 aDOT + 500 HOLLAR
    expect(nav).toBeCloseTo(500.5, 6);
    const incl = nav1Incl(nav, 1_000_000_000n, 10n ** 18n, P, D);
    expect(incl).toBeCloseTo(501.6, 6);
    expect(sharePrice(incl, 1000n * 10n ** 18n)).toBeCloseTo(0.5016, 9);
    expect(sharePrice(null, 1n)).toBeNull();
    expect(sharePrice(1, 0n)).toBeNull();
  });
});

describe('composition (wiki §7.1)', () => {
  it('reproduces the table at X = 0.9: base 0.2, limit 0.8, reflect 0.1', () => {
    const c = compositionFromX(0.9);
    expect(c.baseShare).toBeCloseTo(0.2, 12);
    expect(c.limitShare).toBeCloseTo(0.8, 12);
    expect(c.twoXMinusOne).toBeCloseTo(0.8, 12);
    expect(c.reflectTo).toBeCloseTo(0.1, 12);
  });

  it('is symmetric: X and 1−X carry the same limit share, and balance is all base', () => {
    for (const [x, base, limit] of [
      [0.5, 1, 0],
      [0.6, 0.8, 0.2],
      [0.75, 0.5, 0.5],
      [0.9, 0.2, 0.8],
      [0.1, 0.2, 0.8],
      [1, 0, 1],
    ] as Array<[number, number, number]>) {
      const c = compositionFromX(x);
      expect([x, +c.baseShare.toFixed(9)]).toEqual([x, base]);
      expect([x, +c.limitShare.toFixed(9)]).toEqual([x, limit]);
    }
  });

  it('measures X from the position amounts when they are sampled', () => {
    const P = 1;
    const c = composition(
      { total0: 90_000_000_000n, total1: 10n ** 18n, baseAmt0: 10_000_000_000n, baseAmt1: 10n ** 18n, limitAmt0: 80_000_000_000n, limitAmt1: 0n },
      P,
      D,
    );
    expect(c?.x).toBeCloseTo(0.9, 9);
    expect(c?.baseShare).toBeCloseTo(0.2, 9);
    expect(c?.limitShare).toBeCloseTo(0.8, 9);
    expect(c?.twoXMinusOne).toBeCloseTo(0.8, 9);
  });
});

describe('the 9-day window (wiki §7.6)', () => {
  // per share at t0: 0.5 aDOT + 0.5 HOLLAR at P0 = 1.00, so sp0 = 1.0;
  // the price falls 20% to 0.80 and the vault ends at 0.86085 per share with
  // 29.7 HOLLAR of retained fees over 1000 shares
  const S = 1000;
  const supply = BigInt(S) * 10n ** 18n;
  const tick0 = tickFor(1.0, D);
  const tickT = tickFor(0.8, D);
  const P0 = priceHuman(tick0, D);
  const Pt = priceHuman(tickT, D);
  const NET = -0.0435;
  const FEES = 0.033;

  const q0 = 0.5 / P0;
  const total0Start = BigInt(Math.round(q0 * S * 10 ** D.d0));
  const total1Start = BigInt(Math.round(0.5 * S)) * 10n ** 18n;
  const hodlBasket = q0 * Pt + 0.5; // per share
  const spEndTarget = hodlBasket * (1 + NET);
  const total1End = BigInt(Math.round(spEndTarget * S * 10 ** 18));
  const retained1 = FEES * hodlBasket * S; // 29.7 HOLLAR retained over the window
  const gross1 = BigInt(Math.round(((retained1 * 255) / 254) * 10 ** 18));

  const start: EconPoint = { ts: NOW - 9 * 86400, block: 14000000, tick: tick0, total0: total0Start, total1: total1Start, supply, fees0: 0n, fees1: 0n };
  const end: EconPoint = { ts: NOW, block: 14471204, tick: tickT, total0: 0n, total1: total1End, supply, fees0: 0n, fees1: 0n };
  const zeroBurns: ZeroBurnEv[] = [{ ts: NOW - 4 * 86400, block: 14200000, fee: 255, fees0: 0n, fees1: gross1, tick: tickT, supply }];

  it('starts at a share price of 1.0 and both benchmarks agree from 50/50', () => {
    expect(spAt(start, D)).toBeCloseTo(1.0, 6);
    const q = basketPerShare(start.total0, start.total1, start.supply, D);
    expect(q?.q0).toBeCloseTo(0.5 / P0, 9);
    expect(q?.q1).toBeCloseTo(0.5, 6);
    expect(basketHodl(q!.q0, q!.q1, Pt)).toBeCloseTo(0.9, 4);
    expect(hodl5050(1.0, P0, Pt)).toBeCloseTo(0.9, 4);
  });

  it('reproduces −4.35% basket, +3.3% fees, −7.65% residual', () => {
    const r = economicsWindow({ d: D, start, end, zeroBurns, samples: [], txs: [], refreshTicks: 120, minIntervalSecs: 21600 });
    expect(r.netVsBasketHodl).toBeCloseTo(-0.0435, 4);
    expect(r.feesFrac).toBeCloseTo(0.033, 4);
    expect(r.ilFrac).toBeCloseTo(-0.0765, 4);
    expect(r.ilFrac).toBeCloseTo((r.netVsBasketHodl ?? 0) - (r.feesFrac ?? 0), 12);
    expect(r.netVs5050Hodl).toBeCloseTo(-0.0435, 3);
    expect(r.perShare.spStart).toBeCloseTo(1.0, 4);
    expect(r.perShare.spEnd).toBeCloseTo(0.86085, 4);
  });

  it('splits the gamma skim off the gross ZeroBurn amounts', () => {
    const r = feesRetained(0n, 2550n, 255);
    expect(r.skim1).toBe(10n);
    expect(r.retained1).toBe(2540n);
    const off = feesRetained(0n, 2550n, 0);
    expect(off.skim1).toBe(0n);
    expect(off.retained1).toBe(2550n);
  });

  it('separates the two benchmarks when the vault did not start 50/50', () => {
    const q = { q0: 0.9 / P0, q1: 0.1 };
    const basket = basketHodl(q.q0, q.q1, Pt);
    const fifty = hodl5050(1.0, P0, Pt);
    expect(basket).toBeCloseTo(0.82, 3);
    expect(fifty).toBeCloseTo(0.9, 3);
    expect(basket).toBeLessThan(fifty);
  });
});

describe('time in range, cadence and cost', () => {
  const sample = (ts: number, inBase: boolean, inLimit: boolean, spot: number): RangeSample => ({
    ts,
    inBase,
    inLimit,
    limitLiq: '1000',
    spotTick: spot,
    limitLower: 185880,
    limitUpper: 185940,
    baseShare: inBase ? 0.6 : 0.2,
  });

  it('means in-base, counts band exits and flags a stranded limit', () => {
    const r = timeInRange(
      [sample(1, true, false, 185000), sample(2, true, false, 185000), sample(3, false, false, 184000), sample(4, true, false, 185000)],
      120,
    );
    expect(r.base).toBeCloseTo(0.75, 9);
    expect(r.limit).toBe(0);
    expect(r.bandExits).toBe(1);
    expect(r.twBaseShare).toBeCloseTo(0.5, 9);
    expect(r.limitStrandedFrac).toBe(1); // spot 1880+ ticks below the limit band, liquidity parked
  });

  it('counts actions by kind and both caps', () => {
    const txs: TxLite[] = [
      { hash: '0x1', kind: 'recenter', ts: 100, gasUsed: 815000, gasPriceWei: '1000', costWei: '815000000' },
      { hash: '0x2', kind: 'compound', ts: 200, gasUsed: 643000, gasPriceWei: '1000', costWei: '643000000' },
      { hash: '0x3', kind: 'refresh', ts: 300, gasUsed: 815000, gasPriceWei: '1000', costWei: '815000000' },
    ];
    expect(actionsByKind(txs)).toEqual({ recenter: 1, refresh: 1, fold: 0, compound: 1 });
    const c = cadence(txs, 0, 86400, 21600);
    expect(c.perDay).toBeCloseTo(2, 9);
    expect(c.policyCapPerDay).toBe(POLICY_CAP_PER_DAY);
    expect(c.proxyCapPerDay).toBe(4);
    expect(c.minGapOk).toBe(false); // 200s apart, well under the 6h proxy spacing
  });

  it('averages receipt cost per kind and falls back to an estimate', () => {
    const txs: TxLite[] = [
      { hash: '0x1', kind: 'recenter', ts: 100, gasUsed: 815000, gasPriceWei: '1000', costWei: '800000000' },
      { hash: '0x2', kind: 'recenter', ts: 200, gasUsed: 815000, gasPriceWei: '1000', costWei: '900000000' },
    ];
    const r = costPerTx(txs, null);
    expect(r.costSource).toBe('receipts');
    expect(r.avgCostWei.recenter).toBe(850000000n);
    expect(r.totalWei).toBe(1700000000n);
    const est = costPerTx([], '1000');
    expect(est.costSource).toBe('estimate');
    expect(est.avgCostWei.recenter).toBe((815000n * 1000n * 12n) / 10n);
    expect(burnPerDay(txs, 300, 30)).toBe(1700000000n / 30n);
  });

  it('computes runway in txs and days above the floor', () => {
    const r = gasRunway('10000000', '2000000', '1000000', '500000');
    expect(r.runwayTx).toBe(8);
    expect(r.runwayDays).toBeCloseTo(16, 9);
    expect(gasRunway(null, '0', '1', '1').runwayTx).toBeNull();
    expect(gasRunway('10', '0', '1', null).runwayDays).toBeNull();
  });
});

describe('standing, liveness and verdict', () => {
  const rec = cycleRecord();

  it('reads the armed leg and the action phrase off a record', () => {
    expect(isDue(rec)).toBe(true);
    expect(armedAction(rec)).toBe('TRIGGER 33m/33m');
    expect(armedAction(cycleRecord({ winner: 'hold' }))).toBeNull();
    expect(standingV1({ code: 'gate-blocked', subcode: 'oracle-dev', sinceTs: NOW - 600, seq: 4 }, NOW, 12)).toEqual({
      code: 'gate-blocked',
      subcode: 'oracle-dev',
      sinceTs: NOW - 600,
      secs: 600,
      cycles: 12,
    });
  });

  it('maps the liveness table', () => {
    const base = {
      configured: true,
      reachable: true,
      misses: 0,
      nowTs: NOW,
      bootAtTs: NOW - 4 * 3600,
      headAtTs: NOW - 2,
      busySinceTs: null,
      submitting: false,
      record: rec,
      standing: { code: 'gate-blocked' as const, subcode: 'oracle-dev' as const },
      monitorOverdue: false,
      stalledEvidence: false,
    };
    expect(livenessFor(base)).toBe('blocked-legit');
    expect(livenessFor({ ...base, standing: { code: 'gas-floor', subcode: null } })).toBe('blocked-operational');
    expect(livenessFor({ ...base, misses: 3 })).toBe('unreachable');
    expect(livenessFor({ ...base, reachable: false })).toBe('unreachable');
    expect(livenessFor({ ...base, headAtTs: NOW - 120, stalledEvidence: true })).toBe('stalled');
    expect(livenessFor({ ...base, busySinceTs: NOW - 700 })).toBe('stalled');
    // acting is the live state, not a finalised record: mid-submit, or busy > 5 min
    expect(livenessFor({ ...base, busySinceTs: NOW - 4, submitting: true })).toBe('acting');
    expect(livenessFor({ ...base, busySinceTs: NOW - 400 })).toBe('acting');
    expect(livenessFor({ ...base, busySinceTs: NOW - 4 })).toBe('blocked-legit');
    const quiet = cycleRecord({ winner: 'hold', compoundDue: false, outcome: { code: 'hold', stage: 'triggers', detail: 'in range' }, gate: null });
    quiet.dwell.rebalance.armed = false;
    expect(livenessFor({ ...base, record: quiet, standing: { code: 'hold', subcode: null } })).toBe('quiet');
    expect(worstLiveness(['quiet', 'due', 'unreachable', 'alive'])).toBe('unreachable');
  });

  it('spells the held verdict with the twap-lag hint', () => {
    expect(gateName('gate-blocked', 'oracle-dev')).toBe('oracle clamp');
    expect(gateName('cooldown', null)).toBe('cooldown');
    expect(twapLagHint(185062, rec.gate)).toBe(true);
    const v = verdictFor({
      configured: true,
      standing: { code: 'gate-blocked', subcode: 'oracle-dev' },
      detail: rec.outcome.detail,
      sinceTs: NOW - 7440,
      nowTs: NOW,
      liveness: 'blocked-legit',
      winner: 'TRIGGER',
      dwell: rec.dwell,
      spotTick: 185062,
      gate: rec.gate,
      compoundDueInSecs: 1800,
      dryRunLive: false,
      monitorCritical: null,
      disagreements: 0,
      unreachableSinceTs: null,
      stalled: null,
    });
    expect(v.level).toBe('held');
    expect(v.legit).toBe(true);
    expect(v.sentence).toBe('due work held by oracle clamp (twap lag) 2h04m');
  });

  it('turns a fault into a fault verdict and an unreachable keeper into a sentence', () => {
    const fault = verdictFor({
      configured: true,
      standing: { code: 'gas-floor', subcode: null },
      detail: 'balance 0.0009 below floor 0.001',
      sinceTs: NOW - 60,
      nowTs: NOW,
      liveness: 'blocked-operational',
      winner: 'TRIGGER',
      dwell: null,
      spotTick: null,
      gate: null,
      compoundDueInSecs: null,
      dryRunLive: false,
      monitorCritical: null,
      disagreements: 0,
      unreachableSinceTs: null,
      stalled: null,
    });
    expect(fault.level).toBe('fault');
    expect(fault.legit).toBe(false);
    expect(fault.sentence).toMatch(/^gas-floor:/);

    const goneInput = {
      configured: true,
      standing: null,
      detail: null,
      sinceTs: null,
      nowTs: NOW,
      liveness: 'unreachable',
      winner: null,
      dwell: null,
      spotTick: null,
      gate: null,
      compoundDueInSecs: null,
      dryRunLive: false,
      monitorCritical: null,
      disagreements: 0,
      unreachableSinceTs: NOW - 300,
      stalled: null,
    } as const;
    const gone = verdictFor(goneInput);
    expect(gone.level).toBe('fault');
    expect(gone.code).toBe('keeper-unreachable');
    expect(gone.sentence).toMatch(/^keeper unreachable since /);

    // KEEPER_URL unset is a deployment choice, not an outage
    const never = verdictFor({ ...goneInput, configured: false });
    expect(never.level).toBe('unknown');
    expect(never.code).toBe('keeper-not-configured');
    expect(never.sentence).toBe('keeper not configured');
  });
});

describe('episodes', () => {
  it('extends a run of the same standing and closes it on a change', () => {
    const a = cycleRecord({ seq: 10, blockTs: 1000 });
    const step1 = stepEpisode(null, a);
    expect(step1.close).toBeNull();
    expect(step1.open.code).toBe('gate-blocked');
    expect(step1.open.subcode).toBe('oracle-dev');
    expect(step1.open.cycles).toBe(1);

    const b = cycleRecord({ seq: 11, blockTs: 1060 });
    const step2 = stepEpisode(step1.open, b);
    expect(step2.close).toBeNull();
    expect(step2.open.cycles).toBe(2);
    expect(step2.open.sinceTs).toBe(1000);

    const c = cycleRecord({
      seq: 12,
      blockTs: 1120,
      gate: null,
      winner: 'hold',
      outcome: { code: 'hold', stage: 'triggers', detail: 'in range' },
    });
    const step3 = stepEpisode(step2.open, c);
    expect(step3.close?.code).toBe('gate-blocked');
    expect(step3.close?.cycles).toBe(2);
    expect(step3.open.code).toBe('hold');
    expect(step3.open.sinceTs).toBe(1120);
  });

  it('counts a compound-only cycle whose gate failed as the same gate-blocked run', () => {
    const blocked = cycleRecord({ seq: 20, blockTs: 2000 });
    const compoundOnly = cycleRecord({
      seq: 21,
      blockTs: 2060,
      compoundDue: true,
      outcome: { code: 'compound-only', stage: 'compound', detail: 'compound skipped: pool vs oracle dev 111 > 50' },
      gate: { ...blocked.gate!, via: 'compound-skipped' },
    });
    const first = stepEpisode(null, blocked);
    const second = stepEpisode(first.open, compoundOnly);
    expect(second.close).toBeNull();
    expect(second.open.cycles).toBe(2);
    expect(second.open.code).toBe('gate-blocked');
  });
});
