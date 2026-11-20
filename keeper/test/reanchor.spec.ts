import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { GLOBAL_KEYS, VAULT_KEYS, loadConfig, loadKeeperConfig } from '../src/config';
import { shouldReanchor } from '../src/decide';
import { runReanchor } from '../src/keeper';
import { priceFromSqrtX96, sqrtPriceFromTick, sqrtX96FromPrice, tickFromPrice } from '../src/price';
import { blankState } from '../src/state';
import type { VaultCtx } from '../src/chain';

const KEY = '0x' + '11'.repeat(32);
const VAULT = '0x' + 'aa'.repeat(20);
const FEED = '0x' + 'bb'.repeat(20);
const ROUTER = '0x' + 'cc'.repeat(20);
const QUOTER = '0x' + 'dd'.repeat(20);
const TREASURY = '0x' + 'ee'.repeat(20);
const HOLLAR = '0x' + '01'.repeat(20);
const ATBTC = '0x' + '02'.repeat(20);
const SIGNER = '0x' + '03'.repeat(20);

const BN = ethers.BigNumber.from;
const NOW = 1_795_000_000;
const BTC_USD = 58940.89270066;
// HOLLAR is token0, atBTC token1, the feed prices atBTC: the pool price is 1/usd
const ORACLE_TICK = tickFromPrice(1 / BTC_USD);

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
    REANCHOR_MAX_IN0: '1000000000000000000',
    REANCHOR_MAX_IN1: '10000000000000',
    SWAP_ROUTER: ROUTER,
    QUOTER,
  });
});

afterEach(() => {
  process.env = saved;
});

describe('shouldReanchor', () => {
  const at = (spotTick: number, oracleTick: number) =>
    shouldReanchor({ spotTick, oracleTick, maxDevTicks: 200, maxTicks: 1500 });

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

  it('does not chase a gap past REANCHOR_MAX_TICKS', () => {
    const t = at(-110298, -108000);
    expect(t.trigger).toBe(false);
    expect(t.tooFar).toBe(true);
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
  it('parses the budgets into BigNumbers', () => {
    const cfg = loadConfig();
    expect(cfg.reanchorMaxIn0.toString()).toBe('1000000000000000000');
    expect(cfg.reanchorMaxIn1.toString()).toBe('10000000000000');
  });

  it('needs the oracle, the router, the quoter and a budget', () => {
    process.env.ORACLE_ENABLED = 'false';
    expect(() => loadConfig()).toThrow(/ORACLE_ENABLED/);
    process.env.ORACLE_ENABLED = 'true';
    delete process.env.SWAP_ROUTER;
    expect(() => loadConfig()).toThrow(/SWAP_ROUTER/);
    process.env.SWAP_ROUTER = ROUTER;
    delete process.env.QUOTER;
    expect(() => loadConfig()).toThrow(/QUOTER/);
    process.env.QUOTER = QUOTER;
    process.env.REANCHOR_MAX_IN0 = '0';
    process.env.REANCHOR_MAX_IN1 = '0';
    expect(() => loadConfig()).toThrow(/budget/);
  });

  it('must reach past the oracle clamp', () => {
    process.env.REANCHOR_MAX_TICKS = '200';
    expect(() => loadConfig()).toThrow(/REANCHOR_MAX_TICKS/);
  });

  it('keeps the router and quoter process-wide', () => {
    process.env.VAULTS_JSON = JSON.stringify([{ VAULT, SWAP_ROUTER: ROUTER }]);
    expect(() => loadKeeperConfig()).toThrow(/GLOBAL/);
  });

  it('is off by default and asks for nothing then', () => {
    for (const k of ['REANCHOR_ENABLED', 'SWAP_ROUTER', 'QUOTER', 'REANCHOR_MAX_IN0', 'REANCHOR_MAX_IN1']) delete process.env[k];
    expect(loadConfig().REANCHOR_ENABLED).toBe(false);
  });
});

describe('runReanchor', () => {
  function harness(o: {
    dryRun?: boolean;
    feedAgeSecs?: number;
    usd?: number;
    held1?: ethers.BigNumber;
    reach?: boolean;
    dwellSecs?: number;
  } = {}) {
    if (o.dryRun) process.env.DRY_RUN = 'true';
    const cfg = loadConfig();
    const lines: string[] = [];
    const quote = vi.fn(async (p: any) => ({
      amountOut: BN('1612571438082522'),
      sqrtPriceX96After: o.reach === false ? BN(p.sqrtPriceLimitX96).sub(1_000_000_000) : BN(p.sqrtPriceLimitX96),
    }));
    const send = vi.fn();
    const usd = o.usd ?? BTC_USD;
    const ctx = {
      cfg,
      chain: {
        cfg,
        provider: { getBalance: async () => BN('10000000000000000') },
        signer: { address: SIGNER },
      },
      oracle: {
        feed0: {
          address: FEED,
          decimals: async () => 8,
          latestRoundData: async () => ({
            answer: BN(Math.round(usd * 1e8)),
            updatedAt: BN(NOW - (o.feedAgeSecs ?? 60)),
          }),
        },
      },
      reanchor: {
        quoter: { callStatic: { quoteExactInputSingle: quote } },
        router: { address: ROUTER, exactInputSingle: send, callStatic: { exactInputSingle: send } },
        fee: 3000,
      },
      token0: { address: HOLLAR, balanceOf: async () => BN(0) },
      token1: { address: ATBTC, balanceOf: async () => o.held1 ?? BN('5000000000000') },
      symbol0: 'HOLLAR',
      symbol1: 'atBTC',
      decimals0: 18,
      decimals1: 18,
      dwellSecs: o.dwellSecs ?? 0,
      state: blankState(),
      log: (m: string) => lines.push(m.trim()),
    } as unknown as VaultCtx;
    return { ctx, lines, quote, send };
  }

  const SPOT = -110298;

  it('plans a capped sell of atBTC with its limit at the oracle price', async () => {
    const h = harness({ dryRun: true });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(h.quote).toHaveBeenCalledTimes(1);
    const p = h.quote.mock.calls[0][0];
    expect(p.tokenIn).toBe(ATBTC);
    expect(p.tokenOut).toBe(HOLLAR);
    expect(p.fee).toBe(3000);
    // the signer holds less than the budget: it sells what it has
    expect(p.amountIn.toString()).toBe('5000000000000');
    expect(p.sqrtPriceLimitX96.eq(sqrtX96FromPrice(1 / BTC_USD))).toBe(true);
    expect(tickFromPrice(priceFromSqrtX96(p.sqrtPriceLimitX96))).toBe(ORACLE_TICK);
    expect(h.lines.some((l) => l.startsWith('re-anchor: DRY_RUN'))).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('waits out the dwell before it trades', async () => {
    const h = harness({ dryRun: true, dwellSecs: 600 });
    await runReanchor(h.ctx, SPOT, NOW);
    expect(h.quote).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.startsWith('arming re-anchor'))).toBe(true);
    await runReanchor(h.ctx, SPOT, NOW + 600);
    expect(h.quote).toHaveBeenCalledTimes(1);
  });

  it('leaves a gap with real liquidity in it to arbitrage', async () => {
    const h = harness({ reach: false });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(h.lines.some((l) => l.includes('leaving it to arbitrage'))).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('asks for funding instead of quoting when the signer holds none of the token to sell', async () => {
    const h = harness({ held1: BN(0) });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(h.quote).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('holds no atBTC'))).toBe(true);
  });

  it('does nothing while spot is within the clamp', async () => {
    const h = harness({ dryRun: true });
    const spotNearOracle = ORACLE_TICK - 150;
    expect(await runReanchor(h.ctx, spotNearOracle, NOW)).toBe(false);
    expect(h.quote).not.toHaveBeenCalled();
    expect(h.lines).toEqual([]);
  });

  it('never targets a stale feed', async () => {
    const h = harness({ dryRun: true, feedAgeSecs: 50_000 });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(h.quote).not.toHaveBeenCalled();
  });

  it('says so, and stays put, when the gap is too wide to be a stale pool', async () => {
    const h = harness({ dryRun: true });
    expect(await runReanchor(h.ctx, ORACLE_TICK - 2000, NOW)).toBe(false);
    expect(h.quote).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('not chasing it'))).toBe(true);
  });

  it('respects its own interval and the extreme regime', async () => {
    const cooled = harness({ dryRun: true });
    cooled.ctx.state.lastReanchorTs = NOW - 60;
    expect(await runReanchor(cooled.ctx, SPOT, NOW)).toBe(false);
    expect(cooled.quote).not.toHaveBeenCalled();
    expect(cooled.lines.some((l) => l.startsWith('re-anchor: min interval'))).toBe(true);

    const extreme = harness({ dryRun: true });
    extreme.ctx.state.regime = { regime: 'extreme', since: NOW - 60 };
    expect(await runReanchor(extreme.ctx, SPOT, NOW)).toBe(false);
    expect(extreme.quote).not.toHaveBeenCalled();
  });
});
