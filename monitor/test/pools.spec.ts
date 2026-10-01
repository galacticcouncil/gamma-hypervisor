import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { loadConfig } from '../src/config';
import { feedPriceHuman, human, poolPriceHuman, tickFromHuman } from '../src/checks';
import {
  KEY_MAP,
  describePool,
  loadPoolSpecs,
  resolvePool,
  specFromEnv,
  specsFromDescriptor,
  type ChainReader,
} from '../src/pools';

const A = (b: string) => '0x' + b.repeat(20);
const VAULT = '0xA206d0959813F17C17c87147271c49065438648a';

// the live monitor block of mainnet.stack.yml, addresses swapped for fixtures
const flat: NodeJS.ProcessEnv = {
  RPC_URL: 'https://rpc.example.test',
  KEEPER: A('0b'),
  VAULT,
  POOL: A('5c'),
  CLEARING: A('35'),
  PRICE_FEED: A('fb'),
  DISCORD_WEBHOOK: '',
  CHECK_INTERVAL_SECS: '300',
  REALERT_SECS: '21600',
  GAS_WARN_WEI: '2000000000000000',
  GAS_FLOOR_WEI: '1000000000000000',
  REBALANCE_PROXY: A('8b'),
  REBALANCE_THRESHOLD_MULT: '11',
  MIN_INTERVAL_SECS: '21600',
  REBALANCE_GRACE_SECS: '7200',
  ORACLE_MAX_DEV_TICKS: '50',
  TWAP_WINDOW_SECS: '3600',
  MIN_TWAP_WINDOW_SECS: '3000',
  LIMIT_REFRESH_TICKS: '120',
  DIVERGENCE_BPS: '200',
  STALE_SECONDS: '28800',
};

describe('config', () => {
  it('treats a blank webhook as unset and keeps the 0.3.0 defaults', () => {
    const c = loadConfig(flat);
    expect(c.DISCORD_WEBHOOK).toBeUndefined();
    expect(c.STATUS_PORT).toBe(0);
    expect(c.FAIL_ALERT_CYCLES).toBe(3);
    expect(c.VAULTS_FILE).toBeUndefined();
    expect(c.TWAP_ENABLED).toBe(true);
    expect(c.LIMIT_REFRESH_ENABLED).toBe(true);
    expect(c.rpcHost).toBe('rpc.example.test');
    expect(c.gasWarn.toString()).toBe('2000000000000000');
    const d = loadConfig({ RPC_URL: flat.RPC_URL, KEEPER: flat.KEEPER, VAULT, REBALANCE_PROXY: A('8b') });
    expect([d.REBALANCE_THRESHOLD_MULT, d.MIN_INTERVAL_SECS, d.ORACLE_MAX_DEV_TICKS, d.MIN_TWAP_WINDOW_SECS]).toEqual([11, 21600, 50, 600]);
    expect(d.REBALANCE_GRACE_SECS).toBe(7200);
  });

  it('requires VAULT and REBALANCE_PROXY only without VAULTS_FILE, naming keys not values', () => {
    expect(() => loadConfig({ RPC_URL: flat.RPC_URL, KEEPER: flat.KEEPER })).toThrow(/VAULT: required unless VAULTS_FILE/);
    expect(() => loadConfig({ RPC_URL: flat.RPC_URL, KEEPER: flat.KEEPER })).toThrow(/REBALANCE_PROXY: required/);
    const c = loadConfig({ RPC_URL: flat.RPC_URL, KEEPER: flat.KEEPER, VAULTS_FILE: '/run/config/vaults.json' });
    expect(c.VAULTS_FILE).toBe('/run/config/vaults.json');
    expect(c.VAULT).toBeUndefined();
    expect(() => loadConfig({ ...flat, DISCORD_WEBHOOK: 'not a url' })).toThrow(/DISCORD_WEBHOOK: Invalid url/);
    try { loadConfig({ ...flat, DISCORD_WEBHOOK: 'nope-secret' }); } catch (e) { expect((e as Error).message).not.toContain('nope-secret'); }
  });

  it('flat env yields one pool exactly as before', () => {
    const s = specFromEnv(loadConfig(flat));
    expect(s).toEqual({
      id: VAULT.toLowerCase(), label: null, vault: VAULT, pool: A('5c'), proxy: A('8b'), clearing: A('35'),
      feed: A('fb'), feed1: null, feed0Side: 'token0',
      thresholds: {
        REBALANCE_THRESHOLD_MULT: 11, MIN_INTERVAL_SECS: 21600, REBALANCE_GRACE_SECS: 7200,
        TWAP_ENABLED: true, TWAP_WINDOW_SECS: 3600, MIN_TWAP_WINDOW_SECS: 3000,
        ORACLE_MAX_DEV_TICKS: 50, STALE_SECONDS: 28800,
        LIMIT_REFRESH_ENABLED: true, LIMIT_REFRESH_TICKS: 120, DIVERGENCE_BPS: 200,
      },
    });
    expect(loadPoolSpecs(loadConfig(flat))).toEqual({ source: 'env', specs: [s] });
  });

  it('blank optional addresses switch their gates off', () => {
    const s = specFromEnv(loadConfig({ ...flat, PRICE_FEED: '', CLEARING: '', POOL: '', LIMIT_REFRESH_ENABLED: 'false' }));
    expect(s.feed).toBeNull();
    expect(s.clearing).toBeNull();
    expect(s.pool).toBeNull();
    expect(s.thresholds.ORACLE_MAX_DEV_TICKS).toBeNull();
    expect(s.thresholds.STALE_SECONDS).toBeNull();
    expect(s.thresholds.LIMIT_REFRESH_ENABLED).toBe(false);
    expect(describePool(s)).toContain('oracle off');
    expect(describePool(s)).toContain('clearing off');
    expect(describePool(s)).toContain('limit refresh off');
  });
});

// one entry of vaults.json as the plan writes it: keeper keys, monitor keys, ui keys
const entry = {
  VAULT,
  LABEL: 'aDOT/HOLLAR',
  ENTRYPOINT: 'proxy',
  REBALANCE_PROXY: A('8b'),
  ADMIN_ADDRESS: A('8f'),
  FEE_RECIPIENT: A('6d'),
  DWELL_SECS: 2025,
  REBALANCE_THRESHOLD_MULT: 11,
  MIN_INTERVAL_SECS: 21600,
  TWAP_ENABLED: true,
  TWAP_WINDOW_SECS: 3600,
  MIN_TWAP_WINDOW_SECS: 3000,
  MAX_DEV_TICKS: 100,
  LIMIT_REFRESH_ENABLED: true,
  LIMIT_REFRESH_TICKS: 120,
  FOLD_ENABLED: false,
  ORACLE_ENABLED: true,
  ORACLE_FEED0: A('fb'),
  ORACLE_FEED0_SIDE: 'token0',
  ORACLE_MAX_AGE_SECS: 28800,
  ORACLE_MAX_DEV_TICKS: 50,
  REGIME_ENABLED: false,
  MONITOR_CLEARING: A('35'),
  MONITOR_GRACE_SECS: 7200,
  MONITOR_DIVERGENCE_BPS: 200,
  UI_START_BLOCK: 14_000_000,
};

describe('descriptor', () => {
  it('maps the descriptor keys onto the flat-env meaning', () => {
    const [s] = specsFromDescriptor([entry]);
    expect(s).toEqual({
      id: VAULT.toLowerCase(), label: 'aDOT/HOLLAR', vault: VAULT, pool: null, proxy: A('8b'), clearing: A('35'),
      feed: A('fb'), feed1: null, feed0Side: 'token0',
      thresholds: specFromEnv(loadConfig(flat)).thresholds,
    });
  });

  it('KEY_MAP covers every per-pool flat key and points at real descriptor keys', () => {
    const flatPoolKeys = ['VAULT', 'POOL', 'CLEARING', 'REBALANCE_PROXY', 'PRICE_FEED', 'PRICE_FEED_SIDE', 'REBALANCE_THRESHOLD_MULT',
      'MIN_INTERVAL_SECS', 'REBALANCE_GRACE_SECS', 'ORACLE_MAX_DEV_TICKS', 'TWAP_ENABLED', 'TWAP_WINDOW_SECS', 'MIN_TWAP_WINDOW_SECS',
      'LIMIT_REFRESH_ENABLED', 'LIMIT_REFRESH_TICKS', 'DIVERGENCE_BPS', 'STALE_SECONDS'];
    expect(Object.keys(KEY_MAP).sort()).toEqual(flatPoolKeys.sort());
    for (const [flatKey, descKey] of Object.entries(KEY_MAP)) {
      if (descKey === null) { expect(flatKey).toBe('POOL'); continue; }
      expect(entry).toHaveProperty(descKey);
    }
  });

  it('accepts json booleans and env spellings, numbers as strings', () => {
    const [s] = specsFromDescriptor([{ ...entry, TWAP_ENABLED: 'true', LIMIT_REFRESH_ENABLED: '1', ORACLE_ENABLED: 'yes', MIN_INTERVAL_SECS: '21600' }]);
    expect(s.thresholds.TWAP_ENABLED).toBe(true);
    expect(s.thresholds.LIMIT_REFRESH_ENABLED).toBe(true);
    expect(s.feed).toBe(A('fb'));
    expect(s.thresholds.MIN_INTERVAL_SECS).toBe(21600);
    const [t] = specsFromDescriptor([{ ...entry, TWAP_ENABLED: 'false' }]);
    expect(t.thresholds.TWAP_ENABLED).toBe(false);
  });

  it('a vault without an oracle has no feed and no oracle thresholds', () => {
    const { ORACLE_FEED0, ORACLE_MAX_AGE_SECS, ORACLE_MAX_DEV_TICKS, MONITOR_CLEARING, ...rest } = entry;
    const [s] = specsFromDescriptor([{ ...rest, ORACLE_ENABLED: false, LABEL: 'HOLLAR/USDT' }]);
    expect(s.feed).toBeNull();
    expect(s.feed1).toBeNull();
    expect(s.clearing).toBeNull();
    expect(s.thresholds.ORACLE_MAX_DEV_TICKS).toBeNull();
    expect(s.thresholds.STALE_SECONDS).toBeNull();
    // a feed listed but disabled is still off: the keeper has no clamp to mirror
    const [u] = specsFromDescriptor([{ ...entry, ORACLE_ENABLED: false }]);
    expect(u.feed).toBeNull();
    // two feeds ride along when enabled
    const [v] = specsFromDescriptor([{ ...entry, ORACLE_FEED1: A('f1'), ORACLE_FEED0_SIDE: 'token1' }]);
    expect(v.feed1).toBe(A('f1'));
    expect(v.feed0Side).toBe('token1');
  });

  it('mirrored values are required outright — no defaults behind an enabled gate', () => {
    const drop = (k: string) => { const o: Record<string, unknown> = { ...entry }; delete o[k]; return [o]; };
    expect(() => specsFromDescriptor(drop('TWAP_WINDOW_SECS'))).toThrow(/\[0\]: TWAP_WINDOW_SECS: required when TWAP_ENABLED=true/);
    expect(() => specsFromDescriptor(drop('MIN_TWAP_WINDOW_SECS'))).toThrow(/MIN_TWAP_WINDOW_SECS/);
    expect(() => specsFromDescriptor(drop('ORACLE_MAX_DEV_TICKS'))).toThrow(/ORACLE_MAX_DEV_TICKS: required when ORACLE_ENABLED=true/);
    expect(() => specsFromDescriptor(drop('ORACLE_MAX_AGE_SECS'))).toThrow(/ORACLE_MAX_AGE_SECS/);
    expect(() => specsFromDescriptor(drop('ORACLE_FEED0'))).toThrow(/ORACLE_FEED0/);
    expect(() => specsFromDescriptor(drop('LIMIT_REFRESH_TICKS'))).toThrow(/LIMIT_REFRESH_TICKS: required when LIMIT_REFRESH_ENABLED=true/);
    expect(() => specsFromDescriptor(drop('REBALANCE_THRESHOLD_MULT'))).toThrow(/REBALANCE_THRESHOLD_MULT/);
    expect(() => specsFromDescriptor(drop('MIN_INTERVAL_SECS'))).toThrow(/MIN_INTERVAL_SECS/);
    expect(() => specsFromDescriptor(drop('TWAP_ENABLED'))).toThrow(/TWAP_ENABLED/);
    expect(() => specsFromDescriptor(drop('ORACLE_ENABLED'))).toThrow(/ORACLE_ENABLED/);
    expect(() => specsFromDescriptor(drop('LIMIT_REFRESH_ENABLED'))).toThrow(/LIMIT_REFRESH_ENABLED/);
    expect(() => specsFromDescriptor(drop('REBALANCE_PROXY'))).toThrow(/REBALANCE_PROXY/);
    // gates that are off need none of their numbers
    const { TWAP_WINDOW_SECS, MIN_TWAP_WINDOW_SECS, LIMIT_REFRESH_TICKS, ...rest } = entry;
    expect(() => specsFromDescriptor([{ ...rest, TWAP_ENABLED: false, LIMIT_REFRESH_ENABLED: false }])).not.toThrow();
    // the monitor's own keys do default
    const { MONITOR_GRACE_SECS, MONITOR_DIVERGENCE_BPS, ...noMon } = entry;
    const [s] = specsFromDescriptor([noMon]);
    expect(s.thresholds.REBALANCE_GRACE_SECS).toBe(7200);
    expect(s.thresholds.DIVERGENCE_BPS).toBe(200);
  });

  it('reads json null as unset, the way the descriptor spells it', () => {
    const [s] = specsFromDescriptor([{ ...entry, ORACLE_FEED1: null }]);
    expect(s.feed1).toBeNull();
    // an optional key nulled falls back to its default, not to a type error
    const [t] = specsFromDescriptor([{ ...entry, MONITOR_GRACE_SECS: null, MONITOR_CLEARING: null }]);
    expect(t.thresholds.REBALANCE_GRACE_SECS).toBe(7200);
    expect(t.clearing).toBeNull();
    // a mirrored one still fails, as missing rather than as a type error
    expect(() => specsFromDescriptor([{ ...entry, ORACLE_FEED0: null }])).toThrow(/ORACLE_FEED0: required when ORACLE_ENABLED=true/);
  });

  it('loads the committed descriptors the three services share', () => {
    for (const f of ['vaults.mainnet.json', 'vaults.lark4.json']) {
      const doc: unknown = JSON.parse(readFileSync(join(import.meta.dirname, '../../keeper/deploy', f), 'utf8'));
      const specs = specsFromDescriptor(doc, f);
      expect(specs.length).toBeGreaterThan(0);
      for (const s of specs) expect(s.proxy).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('rejects a non-array, an empty list, a duplicate vault and a bad address', () => {
    expect(() => specsFromDescriptor({ vaults: [] })).toThrow(/expected a JSON array/);
    expect(() => specsFromDescriptor([])).toThrow(/no vaults/);
    expect(() => specsFromDescriptor([entry, { ...entry, VAULT: VAULT.toUpperCase().replace('0X', '0x') }])).toThrow(/listed twice/);
    expect(() => specsFromDescriptor([{ ...entry, VAULT: '0x123' }])).toThrow(/\[0\]: VAULT/);
  });

  it('loads from VAULTS_FILE and reports the source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gamma-monitor-'));
    const file = join(dir, 'vaults.json');
    writeFileSync(file, JSON.stringify([entry, { ...entry, VAULT: A('bb'), LABEL: 'tBTC/HOLLAR' }]));
    const cfg = loadConfig({ RPC_URL: flat.RPC_URL, KEEPER: flat.KEEPER, VAULTS_FILE: file, VAULT: '0xbad' });
    const { source, specs } = loadPoolSpecs(cfg);
    expect(source).toBe('VAULTS_FILE');
    expect(specs.map((s) => s.label)).toEqual(['aDOT/HOLLAR', 'tBTC/HOLLAR']);
    writeFileSync(file, '{ not json');
    expect(() => loadPoolSpecs(cfg)).toThrow(/VAULTS_FILE: cannot read or parse/);
    expect(() => loadPoolSpecs(loadConfig({ ...cfg, VAULTS_FILE: join(dir, 'missing.json') } as never))).toThrow(/VAULTS_FILE: cannot read/);
  });
});

describe('resolvePool', () => {
  const T0 = A('02'), T1 = A('53'), POOL = A('5c');
  const reader = (over: Partial<ChainReader> = {}): ChainReader => ({
    pool: async () => POOL,
    tokens: async () => [T0, T1],
    decimals: async (t) => (t === T0 ? 10 : 18),
    symbol: async (t) => (t === T0 ? 'aDOT' : 'HOLLAR'),
    ...over,
  });

  it('derives the pool, reads decimals once, names the pool from symbols', async () => {
    const [s] = specsFromDescriptor([{ ...entry, LABEL: undefined }]);
    const p = await resolvePool(s, reader());
    expect(p).toMatchObject({ pool: POOL, dec0: 10, dec1: 18, sym0: 'aDOT', sym1: 'HOLLAR', label: 'aDOT/HOLLAR' });
    const [l] = specsFromDescriptor([entry]);
    expect((await resolvePool(l, reader())).label).toBe('aDOT/HOLLAR');
  });

  it('keeps an explicit POOL, survives a missing symbol, refuses missing decimals', async () => {
    const s = specFromEnv(loadConfig(flat));
    const calls: string[] = [];
    const p = await resolvePool(s, reader({ pool: async () => { calls.push('pool'); return A('00'); }, symbol: async () => { throw new Error('no symbol()'); } }));
    expect(calls).toEqual([]);
    expect(p.pool).toBe(A('5c'));
    expect([p.sym0, p.sym1, p.label]).toEqual(['?', '?', '?/?']);
    await expect(resolvePool(s, reader({ decimals: async () => { throw new Error('call revert'); } }))).rejects.toThrow(/call revert/);
    await expect(resolvePool(s, reader({ decimals: async () => NaN }))).rejects.toThrow(/decimals unreadable/);
  });
});

describe('price math replaces the aDOT/HOLLAR literals', () => {
  it('poolPriceHuman(…,10,18) is the old ×1e-8 and tickFromHuman(…,10,18) the old ×1e8', () => {
    for (const tick of [185062, 184200, -50000, 0]) {
      const oldPx = Math.pow(1.0001, tick) * 1e-8;
      expect(poolPriceHuman(tick, 10, 18)).toBeCloseTo(oldPx, 12);
      const oldTick = Math.round(Math.log(oldPx * 1e8) / Math.log(1.0001));
      expect(tickFromHuman(oldPx, 10, 18)).toBe(oldTick);
      expect(tickFromHuman(poolPriceHuman(tick, 10, 18), 10, 18)).toBe(tick);
    }
    // equal decimals: human == raw
    expect(poolPriceHuman(0, 18, 18)).toBe(1);
    expect(tickFromHuman(1, 6, 6)).toBe(0);
    // 8/18 (tBTC/HOLLAR shape): a whole decade off from the 10/18 literal
    expect(poolPriceHuman(0, 8, 18)).toBeCloseTo(1e-10, 20);
  });

  it('feedPriceHuman orients one or two usd feeds as the keeper does', () => {
    expect(feedPriceHuman(4.2, null, 'token0')).toBe(4.2);
    expect(feedPriceHuman(4.2, null, 'token1')).toBeCloseTo(1 / 4.2, 12);
    expect(feedPriceHuman(60000, 1.0, 'token0')).toBe(60000);
    expect(feedPriceHuman(1.0, 60000, 'token1')).toBe(60000);
  });

  it('human() formats a raw balance by decimals', () => {
    expect(human(ethers.BigNumber.from('12345000000000'), 10)).toBe(1234.5);
    expect(human(ethers.utils.parseEther('3.25'), 18)).toBe(3.25);
  });
});
