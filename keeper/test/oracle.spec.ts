import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { readOracleTick } from '../src/oracle';
import { tickFromPrice } from '../src/price';

// Minimal stand-in for a DIA getValue(key) contract.
function fakeOracle(values: Record<string, [string, number]>) {
  return {
    getValue: async (key: string) => {
      const v = values[key];
      if (!v) throw new Error(`no feed ${key}`);
      return [ethers.BigNumber.from(v[0]), ethers.BigNumber.from(v[1])];
    },
  } as unknown as ethers.Contract;
}

const NOW = 1_800_000_000;
const dia = (usd: number) => (usd * 1e8).toString(); // DIA feeds carry 8 decimals

describe('readOracleTick', () => {
  it('converts a two-feed ratio into the expected pool tick (equal decimals)', async () => {
    // DOT $4, HOLLAR $1 -> 4 HOLLAR per DOT.
    const o = await readOracleTick({
      oracle: fakeOracle({ 'DOT/USD': [dia(4), NOW], 'HOLLAR/USD': [dia(1), NOW] }),
      key0: 'DOT/USD',
      key1: 'HOLLAR/USD',
      priceDecimals: 8,
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.tick).toBe(tickFromPrice(4));
    expect(o.ageSecs).toBe(0);
  });

  it('adjusts for differing token decimals', async () => {
    // Human price 4, but token0 has 10 decimals and token1 18 -> raw price 4e8.
    const o = await readOracleTick({
      oracle: fakeOracle({ 'DOT/USD': [dia(4), NOW], 'HOLLAR/USD': [dia(1), NOW] }),
      key0: 'DOT/USD',
      key1: 'HOLLAR/USD',
      priceDecimals: 8,
      decimals0: 10,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.tick).toBe(tickFromPrice(4 * 1e8));
  });

  it('supports one-feed mode when token1 is the USD side', async () => {
    const o = await readOracleTick({
      oracle: fakeOracle({ 'DOT/USD': [dia(4), NOW] }),
      key0: 'DOT/USD',
      priceDecimals: 8,
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.tick).toBe(tickFromPrice(4));
  });

  it('reports the age of the STALEST feed', async () => {
    const o = await readOracleTick({
      oracle: fakeOracle({ 'DOT/USD': [dia(4), NOW - 30], 'HOLLAR/USD': [dia(1), NOW - 900] }),
      key0: 'DOT/USD',
      key1: 'HOLLAR/USD',
      priceDecimals: 8,
      decimals0: 18,
      decimals1: 18,
      nowTs: NOW,
    });
    expect(o.ageSecs).toBe(900);
  });

  it('throws on a zero price rather than reporting tick 0', async () => {
    await expect(
      readOracleTick({
        oracle: fakeOracle({ 'DOT/USD': ['0', NOW] }),
        key0: 'DOT/USD',
        priceDecimals: 8,
        decimals0: 18,
        decimals1: 18,
        nowTs: NOW,
      }),
    ).rejects.toThrow(/returned 0/);
  });

  it('propagates a missing feed so the caller fails closed', async () => {
    await expect(
      readOracleTick({
        oracle: fakeOracle({}),
        key0: 'DOT/USD',
        priceDecimals: 8,
        decimals0: 18,
        decimals1: 18,
        nowTs: NOW,
      }),
    ).rejects.toThrow(/no feed/);
  });
});
