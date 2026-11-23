import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { GLOBAL_KEYS, VAULT_KEYS, loadConfig, loadKeeperConfig } from '../src/config';
import { shouldReanchor } from '../src/decide';
import { reanchorCap, runReanchor } from '../src/keeper';
import { priceFromSqrtX96, sqrtPriceFromTick, sqrtX96FromPrice, tickFromPrice } from '../src/price';
import { blankState } from '../src/state';
import { freshSubstrate, precompileAssetId } from '../src/substrate';
import type { VaultCtx } from '../src/chain';
import { anchorOnce, omnipoolPrice } from '../src/reanchor';

const C = vi.hoisted(() => ({ BTC_USD: 58940.89270066 }));

vi.mock('../src/moneyMarket', () => ({ isReservePaused: vi.fn(async () => true) }));

vi.mock('../src/reanchor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/reanchor')>()),
  anchorOnce: vi.fn(async () => ({ sent: true, anchored: true, ok: true, short: false, hash: '0x' + 'ab'.repeat(32) })),
  omnipoolPrice: vi.fn(async () => 1 / C.BTC_USD),
}));

const reverted = (reason: string) =>
  Object.assign(new Error('missing revert data in call exception'), {
    code: 'CALL_EXCEPTION',
    error: { code: 'SERVER_ERROR', error: { code: -32603, message: `VM Exception while processing transaction: revert ${reason}` } },
  });
const timedOut = () =>
  Object.assign(new Error('missing revert data in call exception'), { code: 'CALL_EXCEPTION', error: { code: 'TIMEOUT', message: 'timeout' } });

const KEY = '0x' + '11'.repeat(32);
const VAULT = '0x' + 'aa'.repeat(20);
const FEED = '0x' + 'bb'.repeat(20);
const ANCHOR = '0x' + 'cc'.repeat(20);
const POOL = '0x' + 'dd'.repeat(20);
const TREASURY = '0x' + 'ee'.repeat(20);
const HOLLAR = '0x' + '01'.repeat(20);
const ATBTC = '0x' + '02'.repeat(20);
const SIGNER = '0x' + '03'.repeat(20);
const TBTC = '0x00000000000000000000000000000001000f453d';

const BN = ethers.BigNumber.from;
const NOW = 1_795_000_000;
const BTC_USD = C.BTC_USD;
const ORACLE_TICK = tickFromPrice(1 / BTC_USD);
const TEN_USD_OF_BTC = Math.floor((10 / BTC_USD) * 1e18);

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  for (const k of [...GLOBAL_KEYS, ...VAULT_KEYS, 'VAULTS_JSON', 'VAULTS_FILE', 'PRIVATE_KEY_FILE'])
    delete process.env[k];
  Object.assign(process.env, {
    PRIVATE_KEY: KEY,
    VAULT,
    DRY_RUN: 'false',
    FEE_RECIPIENT: TREASURY,
    ORACLE_ENABLED: 'true',
    ORACLE_FEED0: FEED,
    ORACLE_FEED0_SIDE: 'token1',
    ORACLE_MAX_AGE_SECS: '43200',
    ORACLE_MAX_DEV_TICKS: '200',
    REANCHOR_ENABLED: 'true',
    POOL_ANCHOR: ANCHOR,
  });
});

afterEach(() => {
  process.env = saved;
});

describe('shouldReanchor', () => {
  const at = (spotTick: number, oracleTick: number) => shouldReanchor({ spotTick, oracleTick, maxDevTicks: 200 });

  it('leaves a gap the oracle clamp tolerates alone', () => {
    expect(at(-110298, -110100).trigger).toBe(false);
    expect(at(-110298, -110098).trigger).toBe(false);
  });

  it('sells token1 when the oracle sits above spot in tick terms', () => {
    const t = at(-110298, -109951);
    expect(t.trigger).toBe(true);
    expect(t.zeroForOne).toBe(false);
  });

  it('sells token0 when the oracle sits below spot', () => {
    const t = at(-109951, -110298);
    expect(t.trigger).toBe(true);
    expect(t.zeroForOne).toBe(true);
  });

  it('still fires on a pool pushed thousands of ticks away', () => {
    expect(at(887271, -110298).trigger).toBe(true);
  });
});

describe('sqrtX96FromPrice', () => {
  it('lands on the tick the price names', () => {
    for (const tick of [-110298, -109951, 0, 12345]) {
      const p = Math.pow(1.0001, tick);
      expect(tickFromPrice(priceFromSqrtX96(sqrtX96FromPrice(p)))).toBe(tick);
    }
  });

  it('agrees with the tick-based float helper', () => {
    const x = Number(sqrtX96FromPrice(Math.pow(1.0001, -110298)).toString());
    expect(x / (sqrtPriceFromTick(-110298) * 2 ** 96)).toBeCloseTo(1, 12);
  });
});

describe('re-anchor config', () => {
  it('budgets $10 a side by default, with no raw caps', () => {
    const cfg = loadConfig();
    expect(cfg.REANCHOR_MAX_USD).toBe(10);
    expect(cfg.reanchorMaxIn0).toBeUndefined();
    expect(cfg.reanchorMaxIn1).toBeUndefined();
    expect(cfg.REANCHOR_XCHECK_MAX_BPS).toBe(200);
  });

  it('parses raw caps into BigNumbers', () => {
    Object.assign(process.env, { REANCHOR_MAX_IN0: '1000000000000000000', REANCHOR_MAX_IN1: '0' });
    const cfg = loadConfig();
    expect(cfg.reanchorMaxIn0!.toString()).toBe('1000000000000000000');
    expect(cfg.reanchorMaxIn1!.isZero()).toBe(true);
  });

  it('needs the oracle, the anchor and a budget', () => {
    process.env.ORACLE_ENABLED = 'false';
    expect(() => loadConfig()).toThrow(/ORACLE_ENABLED/);
    process.env.ORACLE_ENABLED = 'true';
    delete process.env.POOL_ANCHOR;
    expect(() => loadConfig()).toThrow(/POOL_ANCHOR/);
    process.env.POOL_ANCHOR = ANCHOR;
    process.env.REANCHOR_MAX_USD = '0';
    expect(() => loadConfig()).toThrow(/budget/);
    process.env.REANCHOR_MAX_IN1 = '10000000000000';
    expect(() => loadConfig()).not.toThrow();
  });

  it('keeps the anchor address process-wide', () => {
    process.env.VAULTS_JSON = JSON.stringify([{ VAULT, POOL_ANCHOR: ANCHOR }]);
    expect(() => loadKeeperConfig()).toThrow(/GLOBAL/);
  });

  it('is off by default and asks for nothing then', () => {
    for (const k of ['REANCHOR_ENABLED', 'POOL_ANCHOR']) delete process.env[k];
    expect(loadConfig().REANCHOR_ENABLED).toBe(false);
  });
});

describe('reanchorCap', () => {
  const ctx = () => ({ cfg: loadConfig(), decimals0: 18, decimals1: 18 }) as unknown as VaultCtx;
  const o = { tick: ORACLE_TICK, ageSecs: 60, price: 1 / BTC_USD, usd0: 1, usd1: BTC_USD };

  it('is $10 of the token sold at the feed price', () => {
    expect(Number(reanchorCap(ctx(), 1, o).toString())).toBeCloseTo(TEN_USD_OF_BTC, -4);
    expect(reanchorCap(ctx(), 0, o).toString()).toBe('10000000000000000000');
  });

  it('takes a raw cap over the dollar budget, and 0 never sells that side', () => {
    Object.assign(process.env, { REANCHOR_MAX_IN1: '10000000000000', REANCHOR_MAX_IN0: '0' });
    expect(reanchorCap(ctx(), 1, o).toString()).toBe('10000000000000');
    expect(reanchorCap(ctx(), 0, o).isZero()).toBe(true);
  });
});

describe('runReanchor', () => {
  function harness(
    o: { dryRun?: boolean; feedAgeSecs?: number; gas?: ethers.BigNumber; dwellSecs?: number; feedFails?: number; held1?: ethers.BigNumber } = {},
  ) {
    if (o.dryRun) process.env.DRY_RUN = 'true';
    const cfg = loadConfig();
    const lines: string[] = [];
    let fails = o.feedFails ?? 0;
    const feedRead = vi.fn(async () => {
      if (fails-- > 0) throw timedOut();
      return { answer: BN(Math.round(BTC_USD * 1e8)), updatedAt: BN(NOW - (o.feedAgeSecs ?? 60)) };
    });
    const api = {
      rpc: { state: { getRuntimeVersion: async () => ({ specVersion: { eq: () => true } }) } },
      runtimeVersion: { specVersion: 1 },
    };
    const ctx = {
      cfg,
      chain: {
        cfg,
        provider: { getBalance: async () => o.gas ?? BN('10000000000000000'), send: async () => '0x1' },
        signer: { address: SIGNER },
        substrate: api,
      },
      oracle: { feed0: { address: FEED, decimals: async () => 8, latestRoundData: feedRead } },
      reanchor: { anchor: { address: ANCHOR }, xcheck: [222, 1000765] },
      pool: { address: POOL, slot0: async () => ({ sqrtPriceX96: BN(1), tick: -109849 }) },
      token0: { address: HOLLAR, balanceOf: async () => BN(0) },
      token1: { address: ATBTC, balanceOf: async () => o.held1 ?? BN(0) },
      symbol0: 'HOLLAR',
      symbol1: 'atBTC',
      tickSpacing: 60,
      decimals0: 18,
      decimals1: 18,
      dwellSecs: o.dwellSecs ?? 0,
      state: blankState(),
      log: (m: string) => lines.push(m.trim()),
    } as unknown as VaultCtx;
    return { ctx, lines, feedRead };
  }

  const SPOT = -110298;
  const sent = () => vi.mocked(anchorOnce).mock.calls[0][0];

  beforeEach(() => {
    vi.mocked(anchorOnce).mockClear();
    vi.mocked(omnipoolPrice).mockClear();
  });

  it('anchors to the oracle price, capped at $10 of the token it sells', async () => {
    const h = harness();
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(true);
    const a = sent();
    expect(a.pool).toBe(POOL);
    expect(a.tokenIn).toBe(ATBTC);
    expect(a.max0.isZero()).toBe(true);
    expect(Number(a.max1.toString())).toBeCloseTo(TEN_USD_OF_BTC, -4);
    expect(a.target.eq(sqrtX96FromPrice(1 / BTC_USD))).toBe(true);
    expect(tickFromPrice(priceFromSqrtX96(a.target))).toBe(ORACLE_TICK);
    expect(h.ctx.state.lastReanchorTs).toBe(NOW);
    expect(h.ctx.state.reanchorDwellSince).toBe(0);
    expect(h.lines.some((l) => l.startsWith('re-anchor: ✓ spot -110298 -> -109849'))).toBe(true);
  });

  it('sells HOLLAR when the pool sits above the oracle in tick terms', async () => {
    const h = harness();
    expect(await runReanchor(h.ctx, ORACLE_TICK + 400, NOW)).toBe(true);
    expect(sent().tokenIn).toBe(HOLLAR);
    expect(sent().max0.toString()).toBe('10000000000000000000');
    expect(sent().max1.isZero()).toBe(true);
  });

  it('anchors a pool pushed thousands of ticks away', async () => {
    const h = harness();
    expect(await runReanchor(h.ctx, ORACLE_TICK - 5000, NOW)).toBe(true);
    expect(anchorOnce).toHaveBeenCalledTimes(1);
  });

  it('only plans in DRY_RUN', async () => {
    const h = harness({ dryRun: true });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(anchorOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.startsWith('re-anchor: DRY_RUN, not sending'))).toBe(true);
  });

  it('waits out the dwell before it trades', async () => {
    const h = harness({ dwellSecs: 600 });
    await runReanchor(h.ctx, SPOT, NOW);
    expect(anchorOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.startsWith('arming re-anchor'))).toBe(true);
    await runReanchor(h.ctx, SPOT, NOW + 600);
    expect(anchorOnce).toHaveBeenCalledTimes(1);
  });

  it('keeps the dwell through a failed oracle read', async () => {
    const h = harness({ dwellSecs: 600, feedFails: 1 });
    Object.assign(h.ctx.state, { reanchorDwellSince: NOW, lastReanchorReadTs: NOW });
    await runReanchor(h.ctx, SPOT, NOW + 300);
    expect(h.ctx.state.reanchorDwellSince).toBe(NOW);
    await runReanchor(h.ctx, SPOT, NOW + 600);
    expect(anchorOnce).toHaveBeenCalledTimes(1);
  });

  it('resets the dwell once the feed has been unreadable for longer than the dwell', async () => {
    const h = harness({ dwellSecs: 600, feedFails: 1 });
    Object.assign(h.ctx.state, { reanchorDwellSince: NOW, lastReanchorReadTs: NOW });
    await runReanchor(h.ctx, SPOT, NOW + 700);
    expect(h.ctx.state.reanchorDwellSince).toBe(0);
    expect(anchorOnce).not.toHaveBeenCalled();
  });

  it('retries an armed re-anchor that cannot complete on the next sample, not every block', async () => {
    vi.mocked(anchorOnce).mockResolvedValue({ sent: false, anchored: false, ok: false, short: true, hash: null });
    const h = harness();
    await runReanchor(h.ctx, SPOT, NOW);
    await runReanchor(h.ctx, SPOT, NOW + 2);
    expect(anchorOnce).toHaveBeenCalledTimes(1);
    await runReanchor(h.ctx, SPOT, NOW + 31);
    expect(anchorOnce).toHaveBeenCalledTimes(2);
    vi.mocked(anchorOnce).mockReset();
    vi.mocked(anchorOnce).mockResolvedValue({ sent: true, anchored: true, ok: true, short: false, hash: '0x' + 'ab'.repeat(32) });
  });

  it('asks for funding when the preflight fails and the signer holds less than the cap', async () => {
    vi.mocked(anchorOnce).mockResolvedValueOnce({ sent: false, anchored: false, ok: false, short: false, hash: null });
    const h = harness({ held1: BN(1000) });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(h.lines.some((l) => l.includes(`holds 1000 of the`) && l.includes('raw atBTC budget, fund it'))).toBe(true);
  });

  it('samples the oracle every 30s until the dwell is armed', async () => {
    const h = harness({ dryRun: true, dwellSecs: 600 });
    await runReanchor(h.ctx, SPOT, NOW);
    await runReanchor(h.ctx, SPOT, NOW + 10);
    expect(h.feedRead).toHaveBeenCalledTimes(1);
    await runReanchor(h.ctx, SPOT, NOW + 31);
    expect(h.feedRead).toHaveBeenCalledTimes(2);
  });

  it('does nothing while spot is within the clamp', async () => {
    const h = harness();
    expect(await runReanchor(h.ctx, ORACLE_TICK - 150, NOW)).toBe(false);
    expect(anchorOnce).not.toHaveBeenCalled();
    expect(h.lines).toEqual([]);
  });

  it('never targets a stale feed', async () => {
    const h = harness({ feedAgeSecs: 50_000 });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(anchorOnce).not.toHaveBeenCalled();
  });

  it('skips when the Omnipool disagrees with the feed', async () => {
    vi.mocked(omnipoolPrice).mockResolvedValueOnce(1 / (BTC_USD * 1.05));
    const h = harness();
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(anchorOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('feed and Omnipool disagree by'))).toBe(true);
  });

  it('acts when the Omnipool agrees within the limit', async () => {
    vi.mocked(omnipoolPrice).mockResolvedValueOnce(1 / (BTC_USD * 1.015));
    const h = harness();
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(true);
  });

  it('skips when the cross-check cannot be read', async () => {
    vi.mocked(omnipoolPrice).mockRejectedValueOnce(new Error('ws closed'));
    const h = harness();
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(anchorOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('cross-check unreadable (ws closed)'))).toBe(true);
  });

  it('leaves a gap holding more than the budget, without starting the interval', async () => {
    vi.mocked(anchorOnce).mockResolvedValueOnce({ sent: false, anchored: false, ok: false, short: true, hash: null });
    const h = harness();
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(h.ctx.state.lastReanchorTs).toBe(0);
    expect(h.lines.some((l) => l.includes('does not reach the oracle'))).toBe(true);
  });

  it('retries after a preflight revert, but backs off after a sent anchor fails', async () => {
    const h = harness();
    vi.mocked(anchorOnce).mockResolvedValueOnce({ sent: false, anchored: false, ok: false, short: false, hash: null });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(h.ctx.state.lastReanchorTs).toBe(0);
    vi.mocked(anchorOnce).mockResolvedValueOnce({ sent: true, anchored: true, ok: false, short: false, hash: '0x01' });
    expect(await runReanchor(h.ctx, SPOT, NOW + 31)).toBe(true);
    expect(h.ctx.state.lastReanchorTs).toBe(NOW + 31);
  });

  it('counts an approve that reached the chain as acting, without starting the interval', async () => {
    vi.mocked(anchorOnce).mockResolvedValueOnce({ sent: true, anchored: false, ok: false, short: false, hash: null });
    const h = harness();
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(true);
    expect(h.ctx.state.lastReanchorTs).toBe(0);
  });

  it('keeps the gas floor', async () => {
    process.env.GAS_FLOOR_WEI = '1000000000000000';
    const h = harness({ gas: BN('900000000000000') });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(anchorOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('below floor'))).toBe(true);
  });

  it('says so when it has no budget for the side it must sell', async () => {
    process.env.REANCHOR_MAX_IN1 = '0';
    const h = harness();
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(anchorOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('no budget to sell atBTC'))).toBe(true);
  });

  it('respects its own interval and the extreme regime', async () => {
    const cooled = harness();
    cooled.ctx.state.lastReanchorTs = NOW - 60;
    expect(await runReanchor(cooled.ctx, SPOT, NOW)).toBe(false);
    expect(cooled.lines.some((l) => l.startsWith('re-anchor: min interval'))).toBe(true);

    Object.assign(process.env, { REGIME_ENABLED: 'true', MM_DATA_PROVIDER: '0x' + '06'.repeat(20), MM_UNDERLYING: TBTC });
    const extreme = harness();
    expect(await runReanchor(extreme.ctx, SPOT, NOW)).toBe(false);
    expect(extreme.lines.some((l) => l.includes('regime EXTREME'))).toBe(true);
    expect(anchorOnce).not.toHaveBeenCalled();
  });
});

describe('anchorOnce', () => {
  const real = () => vi.importActual<typeof import('../src/reanchor')>('../src/reanchor');

  function fakes(o: { allowance?: ethers.BigNumber; preflight?: Error; send?: Error; mined?: Error } = {}) {
    const approve = vi.fn(async () => ({ hash: '0xa1', wait: async () => ({}) }));
    const token = { allowance: async () => o.allowance ?? BN(0), approve };
    vi.spyOn(ethers, 'Contract').mockImplementation((() => token) as any);
    const anchor = {
      address: ANCHOR,
      callStatic: { anchor: vi.fn(async () => { if (o.preflight) throw o.preflight; return [BN(0), BN(0)]; }) },
      anchor: vi.fn(async () => {
        if (o.send) throw o.send;
        return { hash: '0xb2', wait: async () => { if (o.mined) throw o.mined; return {}; } };
      }),
    };
    const args = {
      signer: { address: SIGNER } as any,
      anchor: anchor as any,
      pool: POOL,
      tokenIn: ATBTC,
      max0: BN(0),
      max1: BN(1000),
      target: BN(123),
      overrides: {},
      confirmations: 1,
      log: () => {},
    };
    return { approve, anchor, args };
  }

  afterEach(() => vi.restoreAllMocks());

  it('approves the cap, then preflights and sends the anchor', async () => {
    const f = fakes();
    const r = await (await real()).anchorOnce(f.args);
    expect(f.approve).toHaveBeenCalledWith(ANCHOR, BN(1000), {});
    expect(f.anchor.callStatic.anchor).toHaveBeenCalledWith(POOL, BN(123), BN(0), BN(1000), {});
    expect(r).toEqual({ sent: true, anchored: true, ok: true, short: false, hash: '0xb2' });
  });

  it('skips the approve when the allowance covers the cap', async () => {
    const f = fakes({ allowance: BN(1000) });
    await (await real()).anchorOnce(f.args);
    expect(f.approve).not.toHaveBeenCalled();
  });

  it('reports a cap that falls short at the preflight, sending nothing', async () => {
    const f = fakes({ allowance: BN(1000), preflight: reverted('target not reached') });
    const r = await (await real()).anchorOnce(f.args);
    expect(f.anchor.anchor).not.toHaveBeenCalled();
    expect(r).toEqual({ sent: false, anchored: false, ok: false, short: true, hash: null });
  });

  it('a send that throws before reaching the chain is neither anchored nor short', async () => {
    const f = fakes({ allowance: BN(1000), send: new Error('nonce too low') });
    const r = await (await real()).anchorOnce(f.args);
    expect(r).toEqual({ sent: false, anchored: false, ok: false, short: false, hash: null });
  });

  it('an anchor that reverts on chain is anchored but not ok', async () => {
    const f = fakes({ allowance: BN(1000), mined: new Error('transaction failed') });
    const r = await (await real()).anchorOnce(f.args);
    expect(r).toEqual({ sent: true, anchored: true, ok: false, short: false, hash: '0xb2' });
  });
});

describe('omnipoolPrice', () => {
  const real = () => vi.importActual<typeof import('../src/reanchor')>('../src/reanchor');
  // HOLLAR: 100 LRNA against 1000 HOLLAR; tBTC: 6000 LRNA against 1 tBTC
  const listed: Record<number, { hub: string; free: string; decimals: number }> = {
    222: { hub: '100000000000000', free: '1000000000000000000000', decimals: 18 },
    1000765: { hub: '6000000000000000', free: '1000000000000000000', decimals: 18 },
  };
  const api = {
    query: {
      omnipool: {
        assets: async (id: number) =>
          listed[id] ? { isNone: false, unwrap: () => ({ hubReserve: listed[id].hub }) } : { isNone: true },
      },
      assetRegistry: { assets: async (id: number) => ({ toJSON: () => ({ decimals: listed[id]?.decimals ?? 18 }) }) },
    },
    call: { currenciesApi: { account: async (id: number) => ({ free: listed[id]?.free ?? '0' }) } },
  };

  it('prices token1 per token0 from hub reserves and balances', async () => {
    expect(await (await real()).omnipoolPrice(api as any, [222, 1000765])).toBeCloseTo(1 / 60000, 12);
  });

  it('throws for an asset not in the Omnipool', async () => {
    await expect((await real()).omnipoolPrice(api as any, [222, 1006])).rejects.toThrow(/not in the Omnipool/);
  });
});

describe('revert classification', () => {
  it('tells a node revert from an rpc failure that ethers also calls CALL_EXCEPTION', async () => {
    const real = await vi.importActual<typeof import('../src/reanchor')>('../src/reanchor');
    expect(real.isRevert(reverted('Unexpected error'))).toBe(true);
    expect(real.isRevert(timedOut())).toBe(false);
    expect(real.isRevert(Object.assign(new Error('could not detect network'), { code: 'NETWORK_ERROR' }))).toBe(false);
    const noCode = Object.assign(new Error('missing revert data in call exception'), {
      code: 'CALL_EXCEPTION',
      error: { code: 'SERVER_ERROR', error: { message: 'execution reverted: 0x' } },
    });
    expect(real.isRevert(noCode)).toBe(true);
    expect(real.revertReason(reverted('target not reached'))).toBe('target not reached');
  });
});

describe('freshSubstrate', () => {
  const api = (same: boolean) => ({
    rpc: { state: { getRuntimeVersion: async () => ({ specVersion: { eq: () => same } }) } },
    runtimeVersion: { specVersion: 1 },
    disconnect: vi.fn(async () => {}),
  });

  it('keeps the api while the runtime is unchanged', async () => {
    const a = api(true);
    const reconnect = vi.fn();
    expect(await freshSubstrate(a as any, reconnect)).toBe(a);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('reconnects after a runtime upgrade, so storage is decoded against the new metadata', async () => {
    const a = api(false);
    const b = api(true);
    expect(await freshSubstrate(a as any, async () => b as any)).toBe(b);
    expect(a.disconnect).toHaveBeenCalled();
  });

  it('keeps the old api if the reconnect fails', async () => {
    const a = api(false);
    await expect(freshSubstrate(a as any, async () => { throw new Error('down'); })).rejects.toThrow('down');
    expect(a.disconnect).not.toHaveBeenCalled();
  });
});

describe('precompileAssetId', () => {
  it('reads the asset id out of a multicurrency precompile address', () => {
    expect(precompileAssetId(TBTC)).toBe(1000765);
    expect(precompileAssetId('0x0000000000000000000000000000000100000014')).toBe(20);
    expect(precompileAssetId(HOLLAR)).toBeNull();
  });
});
