import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { GLOBAL_KEYS, VAULT_KEYS, loadConfig, loadKeeperConfig } from '../src/config';
import { bridgeAmount, bridgeRange, shouldReanchor } from '../src/decide';
import { runReanchor } from '../src/keeper';
import { priceFromSqrtX96, sqrtPriceFromTick, sqrtX96FromPrice, tickFromPrice } from '../src/price';
import { blankState } from '../src/state';
import { freshSubstrate, precompileAssetId } from '../src/substrate';
import type { VaultCtx } from '../src/chain';
import { buyWithGasOnce, clearBridgesOnce, findBridges, mintBridgeOnce, reanchorOnce, wrapOnce } from '../src/reanchor';

vi.mock('../src/reanchor', () => ({
  reanchorOnce: vi.fn(async () => ({ sent: true, ok: true, hash: '0x' + 'ab'.repeat(32) })),
  wrapOnce: vi.fn(async () => '0x' + 'cd'.repeat(32)),
  buyWithGasOnce: vi.fn(async () => '0x' + 'ef'.repeat(32)),
  findBridges: vi.fn(async () => []),
  mintBridgeOnce: vi.fn(async () => ({ hash: '0x' + '12'.repeat(32), tokenId: '3' })),
  clearBridgesOnce: vi.fn(async (i: any) => i.bridges.map((b: any) => b.tokenId.toString())),
  revertReason: (e: any) => String(e?.message ?? e),
}));

const KEY = '0x' + '11'.repeat(32);
const VAULT = '0x' + 'aa'.repeat(20);
const FEED = '0x' + 'bb'.repeat(20);
const ROUTER = '0x' + 'cc'.repeat(20);
const QUOTER = '0x' + 'dd'.repeat(20);
const TREASURY = '0x' + 'ee'.repeat(20);
const HOLLAR = '0x' + '01'.repeat(20);
const ATBTC = '0x' + '02'.repeat(20);
const SIGNER = '0x' + '03'.repeat(20);
const TBTC = '0x00000000000000000000000000000001000f453d';
const MM_POOL = '0x' + '04'.repeat(20);

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

  it('needs the oracle and a budget', () => {
    process.env.ORACLE_ENABLED = 'false';
    expect(() => loadConfig()).toThrow(/ORACLE_ENABLED/);
    process.env.ORACLE_ENABLED = 'true';
    process.env.REANCHOR_MAX_IN0 = '0';
    process.env.REANCHOR_MAX_IN1 = '0';
    expect(() => loadConfig()).toThrow(/budget/);
  });

  it('must reach past the oracle clamp', () => {
    process.env.REANCHOR_MAX_TICKS = '200';
    expect(() => loadConfig()).toThrow(/REANCHOR_MAX_TICKS/);
  });

  it('defaults the router and quoter to hydration mainnet', () => {
    delete process.env.SWAP_ROUTER;
    delete process.env.QUOTER;
    const cfg = loadConfig();
    expect(cfg.SWAP_ROUTER).toBe('0x5a79dE848626994c4099640EF5c48Fd65DAe4159');
    expect(cfg.QUOTER).toBe('0x9D7c18Be9AdD2748784A3c6F9071D67CA8f29974');
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
  const CAP = BN('10000000000000');
  const TBTC_ED = BN('106803374987');

  function harness(o: {
    dryRun?: boolean;
    feedAgeSecs?: number;
    usd?: number;
    held1?: ethers.BigNumber[];
    underlying?: ethers.BigNumber;
    gas?: ethers.BigNumber;
    reach?: boolean | 'revert' | 'rpcfail';
    held0?: ethers.BigNumber;
    activeLiquidity?: ethers.BigNumber;
    dwellSecs?: number;
  } = {}) {
    if (o.dryRun) process.env.DRY_RUN = 'true';
    const cfg = loadConfig();
    const lines: string[] = [];
    const quote = vi.fn(async (p: any) => {
      if (o.reach === 'revert') throw Object.assign(new Error('call revert exception'), { code: 'CALL_EXCEPTION' });
      if (o.reach === 'rpcfail') throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
      return {
        amountOut: BN('1612571438082522'),
        sqrtPriceX96After: o.reach === false ? BN(p.sqrtPriceLimitX96).sub(1_000_000_000) : BN(p.sqrtPriceLimitX96),
      };
    });
    const sell = vi.fn((..._args: unknown[]) => ({ method: { toHex: () => '0xd15a' } }));
    // successive balanceOf reads walk the list, the last value sticks
    const held1 = [...(o.held1 ?? [BN('20000000000000')])];
    const usd = o.usd ?? BTC_USD;
    const ctx = {
      cfg,
      chain: {
        cfg,
        provider: { getBalance: async () => o.gas ?? BN('10000000000000000'), send: async () => '0x1' },
        signer: { address: SIGNER },
        substrate: {
          tx: { router: { sell } },
          rpc: { state: { getRuntimeVersion: async () => ({ specVersion: { eq: () => true } }) } },
          runtimeVersion: { specVersion: 1 },
        },
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
        router: { address: ROUTER },
        npm: { address: '0x' + '05'.repeat(20) },
        fee: 3000,
        sides: [
          { assetId: 222, ed: BN('20000000000000000'), gasRoute: true },
          {
            assetId: 1006,
            ed: BN('208779411374'),
            wrap: { pool: MM_POOL, underlying: { address: TBTC, balanceOf: async () => o.underlying ?? BN(0) }, underlyingEd: TBTC_ED },
            gasRoute: true,
          },
        ],
      },
      pool: { slot0: async () => ({ sqrtPriceX96: BN(1), tick: -109849 }), liquidity: async () => o.activeLiquidity ?? BN(0) },
      token0: { address: HOLLAR, balanceOf: async () => o.held0 ?? BN(0) },
      token1: { address: ATBTC, balanceOf: async () => (held1.length > 1 ? held1.shift()! : held1[0]) },
      symbol0: 'HOLLAR',
      symbol1: 'atBTC',
      tickSpacing: 60,
      decimals0: 18,
      decimals1: 18,
      dwellSecs: o.dwellSecs ?? 0,
      state: blankState(),
      log: (m: string) => lines.push(m.trim()),
    } as unknown as VaultCtx;
    return { ctx, lines, quote, sell };
  }

  const SPOT = -110298;

  beforeEach(() => {
    vi.mocked(reanchorOnce).mockClear();
    vi.mocked(wrapOnce).mockClear();
    vi.mocked(buyWithGasOnce).mockClear();
    vi.mocked(findBridges).mockClear();
    vi.mocked(mintBridgeOnce).mockClear();
    vi.mocked(clearBridgesOnce).mockClear();
  });

  // the vault holds only atBTC asks: nothing between spot and the oracle for the router to cross
  it('lays a dust HOLLAR bridge one spacing past spot when the gap is empty, then swaps next block', async () => {
    const h = harness({ reach: 'revert', held0: BN('1000000000000000000') });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    const m = vi.mocked(mintBridgeOnce).mock.calls[0][0];
    expect([m.tickLower, m.tickUpper]).toEqual([-110280, -110220]);
    // a twentieth of the 1e13 atBTC budget, in HOLLAR at the oracle
    expect(Number(m.amount0.toString())).toBeCloseTo((1e13 * BTC_USD) / 20, -6);
    expect(m.amount1.isZero()).toBe(true);
    expect(reanchorOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('swapping across the bridge next block'))).toBe(true);
  });

  it('buys HOLLAR with gas money for the bridge when it has none', async () => {
    const h = harness({ reach: 'revert' });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(mintBridgeOnce).not.toHaveBeenCalled();
    expect(h.sell).toHaveBeenCalledWith(20, 222, '100000000000000', '20000000000000000', []);
    expect(h.lines.some((l) => l.includes('topped up HOLLAR for a bridge'))).toBe(true);
  });

  it('does not lay a second bridge on the path', async () => {
    vi.mocked(findBridges).mockResolvedValueOnce([{ tokenId: BN(7), tickLower: -110280, tickUpper: -110220, liquidity: BN(5) }]);
    const h = harness({ reach: 'revert', held0: BN('1000000000000000000') });
    h.ctx.state.bridgeIds = ['7'];
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(mintBridgeOnce).not.toHaveBeenCalled();
    expect(clearBridgesOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('still reverts'))).toBe(true);
  });

  it('clears a stale bridge off the path before laying a new one', async () => {
    vi.mocked(findBridges).mockResolvedValueOnce([{ tokenId: BN(7), tickLower: -110400, tickUpper: -110340, liquidity: BN(5) }]);
    const h = harness({ reach: 'revert', held0: BN('1000000000000000000') });
    h.ctx.state.bridgeIds = ['7'];
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(vi.mocked(clearBridgesOnce).mock.calls[0][0].bridges.map((b: any) => b.tokenId.toNumber())).toEqual([7]);
    expect(mintBridgeOnce).not.toHaveBeenCalled();
    expect(h.ctx.state.bridgeIds).toEqual([]);
  });

  it('only ever looks at bridges it laid itself', async () => {
    const h = harness({ reach: 'revert', held0: BN('1000000000000000000') });
    await runReanchor(h.ctx, SPOT, NOW);
    expect(vi.mocked(findBridges).mock.calls[0][1]).toEqual([]);
    expect(h.ctx.state.bridgeIds).toEqual(['3']);
  });

  it('retries an rpc failure instead of bridging it', async () => {
    const h = harness({ reach: 'rpcfail', held0: BN('1000000000000000000') });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(mintBridgeOnce).not.toHaveBeenCalled();
    expect(buyWithGasOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('quote failed, retrying next block'))).toBe(true);
  });

  it('does not call a revert with liquidity at spot an empty gap', async () => {
    const h = harness({ reach: 'revert', held0: BN('1000000000000000000'), activeLiquidity: BN(5) });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(mintBridgeOnce).not.toHaveBeenCalled();
  });

  it('spaces spend actions by REANCHOR_ACTION_INTERVAL_SECS', async () => {
    const h = harness({ reach: 'revert', held0: BN('1000000000000000000') });
    h.ctx.state.lastReanchorActionTs = NOW - 30;
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(mintBridgeOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l === 're-anchor: next action in 90s')).toBe(true);
  });

  it('caps gas buys per day across the signer', async () => {
    const h = harness({ reach: 'revert' });
    (h.ctx.chain as any).gasBuys = Array.from({ length: 6 }, (_, i) => NOW - 1000 + i);
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(buyWithGasOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('gas buys in 24h'))).toBe(true);
  });

  it('takes a leftover bridge back once nothing needs it', async () => {
    const left = { tokenId: BN(5), tickLower: -110280, tickUpper: -110220, liquidity: BN(5) };
    vi.mocked(findBridges).mockResolvedValueOnce([left]);
    const h = harness({ dryRun: false });
    h.ctx.state.bridgeIds = ['5'];
    expect(await runReanchor(h.ctx, ORACLE_TICK - 150, NOW)).toBe(false);
    expect(vi.mocked(clearBridgesOnce).mock.calls[0][0].bridges).toEqual([left]);
    expect(h.ctx.state.bridgeIds).toEqual([]);
  });

  it('clears its bridges after the swap lands', async () => {
    const bridge = { tokenId: BN(9), tickLower: -109740, tickUpper: -109680, liquidity: BN(0) };
    vi.mocked(findBridges).mockResolvedValueOnce([bridge]);
    const h = harness();
    h.ctx.state.bridgeIds = ['9'];
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(true);
    expect(vi.mocked(clearBridgesOnce).mock.calls[0][0].bridges).toEqual([bridge]);
  });

  it('does not top up the swap token for an empty gap', async () => {
    const h = harness({ reach: 'revert', held1: [BN('5000000000000')], held0: BN('1000000000000000000'), underlying: BN('103650801406404') });
    await runReanchor(h.ctx, SPOT, NOW);
    expect(wrapOnce).not.toHaveBeenCalled();
    expect(mintBridgeOnce).toHaveBeenCalledTimes(1);
  });

  it('plans a capped sell of atBTC with its limit at the oracle price', async () => {
    const h = harness({ dryRun: true });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(h.quote).toHaveBeenCalledTimes(1);
    const p = h.quote.mock.calls[0][0];
    expect(p.tokenIn).toBe(ATBTC);
    expect(p.tokenOut).toBe(HOLLAR);
    expect(p.fee).toBe(3000);
    expect(p.amountIn.toString()).toBe(CAP.toString());
    expect(p.sqrtPriceLimitX96.eq(sqrtX96FromPrice(1 / BTC_USD))).toBe(true);
    expect(tickFromPrice(priceFromSqrtX96(p.sqrtPriceLimitX96))).toBe(ORACLE_TICK);
    expect(h.lines.some((l) => l.startsWith('re-anchor: DRY_RUN, not sending'))).toBe(true);
    expect(reanchorOnce).not.toHaveBeenCalled();
  });

  it('swaps live, capped at the budget', async () => {
    const h = harness();
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(true);
    expect(vi.mocked(reanchorOnce).mock.calls[0][0].amountIn.toString()).toBe(CAP.toString());
    expect(h.ctx.state.lastReanchorTs).toBe(NOW);
    expect(h.lines.some((l) => l.startsWith('re-anchor: ✓ spot -110298 -> -109849'))).toBe(true);
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
    expect(reanchorOnce).not.toHaveBeenCalled();
  });

  it('sells a short balance as is when it still reaches the oracle', async () => {
    const h = harness({ held1: [BN('5000000000000')] });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(true);
    expect(wrapOnce).not.toHaveBeenCalled();
    expect(buyWithGasOnce).not.toHaveBeenCalled();
    expect(vi.mocked(reanchorOnce).mock.calls[0][0].amountIn.toString()).toBe('5000000000000');
  });

  it('supplies the underlying it holds, then sells the aToken on the next block', async () => {
    const h = harness({ held1: [BN(0), CAP], underlying: BN('103650801406404') });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    const w = vi.mocked(wrapOnce).mock.calls[0][0];
    expect(w.underlying).toBe(TBTC);
    expect(w.pool).toBe(MM_POOL);
    expect(w.amount.toString()).toBe(CAP.toString());
    expect(buyWithGasOnce).not.toHaveBeenCalled();
    expect(reanchorOnce).not.toHaveBeenCalled();
    expect(h.ctx.state.lastReanchorTs).toBe(0);
    expect(await runReanchor(h.ctx, SPOT, NOW + 2)).toBe(true);
    expect(vi.mocked(reanchorOnce).mock.calls[0][0].amountIn.toString()).toBe(CAP.toString());
    expect(vi.mocked(reanchorOnce).mock.calls[0][0].approve.toString()).toBe(CAP.toString());
  });

  it('supplies all of the underlying rather than leave the duster a remainder', async () => {
    const all = CAP.add(50_000_000_000);
    const h = harness({ held1: [BN(0)], underlying: all });
    await runReanchor(h.ctx, SPOT, NOW);
    expect(vi.mocked(wrapOnce).mock.calls[0][0].amount.toString()).toBe(all.toString());
  });

  it('buys with gas money when there is nothing to supply, asking at least the ED', async () => {
    const h = harness({ held1: [BN(0), BN('3000000000000')] });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(wrapOnce).not.toHaveBeenCalled();
    expect(h.sell).toHaveBeenCalledWith(20, 1006, '100000000000000', '208779411374', []);
    expect(vi.mocked(buyWithGasOnce).mock.calls[0][0].call).toBe('0xd15a');
    expect(await runReanchor(h.ctx, SPOT, NOW + 2)).toBe(true);
    expect(vi.mocked(reanchorOnce).mock.calls[0][0].amountIn.toString()).toBe('3000000000000');
  });

  it('retries next block after a preflight revert, but backs off after a sent swap fails', async () => {
    const h = harness();
    vi.mocked(reanchorOnce).mockResolvedValueOnce({ sent: false, ok: false, hash: null });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(h.ctx.state.lastReanchorTs).toBe(0);
    vi.mocked(reanchorOnce).mockResolvedValueOnce({ sent: true, ok: false, hash: '0x01' });
    expect(await runReanchor(h.ctx, SPOT, NOW + 2)).toBe(false);
    expect(h.ctx.state.lastReanchorTs).toBe(NOW + 2);
  });

  it('keeps the gas floor', async () => {
    process.env.GAS_FLOOR_WEI = '1000000000000000';
    const h = harness({ held1: [BN(0)], gas: BN('1050000000000000') });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(buyWithGasOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('too low to buy with'))).toBe(true);
    expect(h.lines.some((l) => l.includes('could not get any'))).toBe(true);
  });

  it('never buys when REANCHOR_GAS_BUY_IN is 0', async () => {
    process.env.REANCHOR_GAS_BUY_IN = '0';
    const h = harness({ held1: [BN(0)] });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(buyWithGasOnce).not.toHaveBeenCalled();
    expect(h.quote).not.toHaveBeenCalled();
  });

  it('only plans the top-up in DRY_RUN', async () => {
    const h = harness({ dryRun: true, held1: [BN(0)], underlying: BN('103650801406404') });
    expect(await runReanchor(h.ctx, SPOT, NOW)).toBe(false);
    expect(wrapOnce).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.startsWith('re-anchor: DRY_RUN, would supply 10000000000000'))).toBe(true);
  });

  it('does nothing while spot is within the clamp', async () => {
    const h = harness({ dryRun: true });
    expect(await runReanchor(h.ctx, ORACLE_TICK - 150, NOW)).toBe(false);
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

describe('bridge geometry', () => {
  it('sits one full spacing past spot on the side the swap crosses', () => {
    expect(bridgeRange(-109797, false, 60)).toEqual([-109740, -109680]);
    expect(bridgeRange(-109797, true, 60)).toEqual([-109860, -109800]);
    // exactly on a multiple: the down-side bridge may end at spot (token1-only), the up-side starts past it
    expect(bridgeRange(-109800, true, 60)).toEqual([-109860, -109800]);
    expect(bridgeRange(-109800, false, 60)).toEqual([-109740, -109680]);
  });

  it('is a twentieth of the budget at the oracle, in the other token', () => {
    const p = 1 / 58000; // token1 per token0
    expect(Number(bridgeAmount(10_000_000_000_000n, p, false))).toBeCloseTo((1e13 * 58000) / 20, -6);
    expect(Number(bridgeAmount(1_000_000_000_000_000_000n, p, true))).toBeCloseTo((1e18 / 58000) / 20, -2);
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

  it('reconnects after a runtime upgrade, so calls are encoded against the new metadata', async () => {
    const a = api(false);
    const b = api(true);
    expect(await freshSubstrate(a as any, async () => b as any)).toBe(b);
    expect(a.disconnect).toHaveBeenCalled();
  });
});

describe('precompileAssetId', () => {
  it('reads the asset id out of a multicurrency precompile address', () => {
    expect(precompileAssetId(TBTC)).toBe(1000765);
    expect(precompileAssetId('0x0000000000000000000000000000000100000014')).toBe(20);
    expect(precompileAssetId(HOLLAR)).toBeNull();
  });
});
