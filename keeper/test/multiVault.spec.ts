import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GLOBAL_KEYS,
  VAULT_KEYS,
  loadConfig,
  loadKeeperConfig,
  resolveDwellSecs,
  selectVault,
} from '../src/config';
import { stepDwell } from '../src/keeper';
import { blankState } from '../src/state';

const KEY = '0x' + '11'.repeat(32);
const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const C = '0x' + 'cc'.repeat(20);
const TREASURY = '0x' + 'dd'.repeat(20);

let saved: NodeJS.ProcessEnv;

// loadConfig/loadKeeperConfig read process.env directly, and dotenv has already
// populated it by import time — clear every key they look at.
beforeEach(() => {
  saved = { ...process.env };
  for (const k of [...GLOBAL_KEYS, ...VAULT_KEYS, 'VAULTS_JSON', 'VAULTS_FILE', 'PRIVATE_KEY_FILE'])
    delete process.env[k];
  process.env.PRIVATE_KEY = KEY;
  process.env.DRY_RUN = 'false';
  process.env.FEE_RECIPIENT = TREASURY;
});

afterEach(() => {
  process.env = saved;
});

describe('flat env is the defaults layer', () => {
  it('synthesises exactly one vault from VAULT when no list is configured', () => {
    process.env.VAULT = A;
    const { vaults } = loadKeeperConfig();
    expect(vaults).toHaveLength(1);
    expect(vaults[0].VAULT).toBe(A);
  });

  it('parses that one vault identically to the single-vault loader', () => {
    process.env.VAULT = A;
    process.env.BASE_HALF_WIDTH_MULT = '16';
    process.env.ENTRYPOINT = 'proxy';
    process.env.REBALANCE_PROXY = B;
    process.env.DWELL_BLOCKS = '900';
    expect(loadKeeperConfig().vaults[0]).toEqual(loadConfig());
  });

  it('lifts the process-wide settings onto the global layer', () => {
    process.env.VAULT = A;
    process.env.GAS_LIMIT = '1234567';
    process.env.CONFIRMATIONS = '7';
    const { global } = loadKeeperConfig();
    expect(global.GAS_LIMIT).toBe(1234567);
    expect(global.CONFIRMATIONS).toBe(7);
    expect(global.PRIVATE_KEY).toBe(KEY);
  });
});

describe('per-vault overrides', () => {
  it('beat the flat defaults, and unspecified keys inherit them', () => {
    process.env.VAULT = A;
    process.env.BASE_HALF_WIDTH_MULT = '16';
    process.env.MIN_INTERVAL_SECS = '21600';
    process.env.VAULTS_JSON = JSON.stringify([
      { VAULT: A },
      { VAULT: B, BASE_HALF_WIDTH_MULT: 30 },
    ]);

    const { vaults } = loadKeeperConfig();
    expect(vaults.map((v) => v.VAULT)).toEqual([A, B]);
    // overridden
    expect(vaults[0].BASE_HALF_WIDTH_MULT).toBe(16);
    expect(vaults[1].BASE_HALF_WIDTH_MULT).toBe(30);
    // inherited
    expect(vaults[0].MIN_INTERVAL_SECS).toBe(21600);
    expect(vaults[1].MIN_INTERVAL_SECS).toBe(21600);
    expect(vaults[1].FEE_RECIPIENT).toBe(TREASURY);
  });

  it('reads a JSON boolean as a boolean, not as the string "true"', () => {
    // boolEnv compares against the STRING 'true'; an unnormalised JSON boolean
    // would silently turn every override into false.
    process.env.VAULTS_JSON = JSON.stringify([
      { VAULT: A, COMPOUND_ENABLED: true, ADMIN_ADDRESS: C },
      { VAULT: B, COMPOUND_ENABLED: false },
    ]);
    const { vaults } = loadKeeperConfig();
    expect(vaults[0].COMPOUND_ENABLED).toBe(true);
    expect(vaults[1].COMPOUND_ENABLED).toBe(false);
  });

  it('treats a JSON null as "drop the inherited default"', () => {
    process.env.VAULT = A;
    process.env.ORACLE_FEED1 = C;
    process.env.VAULTS_JSON = JSON.stringify([{ VAULT: A }, { VAULT: B, ORACLE_FEED1: null }]);
    const { vaults } = loadKeeperConfig();
    expect(vaults[0].ORACLE_FEED1).toBe(C);
    expect(vaults[1].ORACLE_FEED1).toBeUndefined();
  });

  it('rejects a global setting used as a per-vault override', () => {
    process.env.VAULTS_JSON = JSON.stringify([{ VAULT: A, RPC_URL: 'http://127.0.0.1:1' }]);
    expect(() => loadKeeperConfig()).toThrow(/RPC_URL is a GLOBAL setting/);
  });

  it('rejects a key that is not a keeper setting at all', () => {
    process.env.VAULTS_JSON = JSON.stringify([{ VAULT: A, BASE_HALF_WIDTH: 16 }]);
    expect(() => loadKeeperConfig()).toThrow(/not a known keeper setting/);
  });

  it('lets VAULTS_FILE win over an inline VAULTS_JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keeper-vaults-'));
    const file = join(dir, 'vaults.json');
    writeFileSync(file, JSON.stringify([{ VAULT: C }]));
    process.env.VAULTS_JSON = JSON.stringify([{ VAULT: A }, { VAULT: B }]);
    process.env.VAULTS_FILE = file;
    const { vaults } = loadKeeperConfig();
    expect(vaults.map((v) => v.VAULT)).toEqual([C]);
  });
});

describe('the existing refinements run per vault', () => {
  it('fires ENTRYPOINT=proxy without REBALANCE_PROXY on the offending vault only', () => {
    process.env.VAULTS_JSON = JSON.stringify([
      { VAULT: A, ENTRYPOINT: 'proxy', REBALANCE_PROXY: C },
      { VAULT: B, ENTRYPOINT: 'proxy' },
    ]);
    expect(() => loadKeeperConfig()).toThrow(/REBALANCE_PROXY/);
    // and names which one, so the operator does not have to bisect the list
    expect(() => loadKeeperConfig()).toThrow(new RegExp(`\\[1\\].*${B}`, 'i'));
  });

  it('fires ORACLE_ENABLED without a feed per vault', () => {
    process.env.VAULTS_JSON = JSON.stringify([{ VAULT: A }, { VAULT: B, ORACLE_ENABLED: true }]);
    expect(() => loadKeeperConfig()).toThrow(/ORACLE_FEED0/);
  });

  it('still refuses a live run with the TWAP gate off, per vault', () => {
    process.env.VAULTS_JSON = JSON.stringify([{ VAULT: A }, { VAULT: B, TWAP_ENABLED: false }]);
    expect(() => loadKeeperConfig()).toThrow(/TWAP/);
  });

  it('accepts a list where every vault satisfies its own refinements', () => {
    process.env.VAULTS_JSON = JSON.stringify([
      { VAULT: A, ENTRYPOINT: 'proxy', REBALANCE_PROXY: C },
      { VAULT: B, ORACLE_ENABLED: true, ORACLE_FEED0: C },
    ]);
    const { vaults } = loadKeeperConfig();
    expect(vaults[0].ENTRYPOINT).toBe('proxy');
    expect(vaults[1].ORACLE_ENABLED).toBe(true);
  });
});

describe('duplicate vaults', () => {
  it('are rejected — two contexts on one vault would race the signer nonce', () => {
    process.env.VAULTS_JSON = JSON.stringify([{ VAULT: A }, { VAULT: B }, { VAULT: A }]);
    expect(() => loadKeeperConfig()).toThrow(/duplicate vault address/i);
  });

  it('are rejected regardless of address casing', () => {
    process.env.VAULTS_JSON = JSON.stringify([{ VAULT: A }, { VAULT: A.toUpperCase().replace('0X', '0x') }]);
    expect(() => loadKeeperConfig()).toThrow(/duplicate vault address/i);
  });
});

describe('vault selection for the one-shot tools', () => {
  it('needs no selector when there is one vault', () => {
    process.env.VAULT = A;
    const { vaults } = loadKeeperConfig();
    expect(selectVault(vaults).VAULT).toBe(A);
  });

  it('refuses to guess between several, and lists them', () => {
    process.env.VAULTS_JSON = JSON.stringify([{ VAULT: A }, { VAULT: B }]);
    const { vaults } = loadKeeperConfig();
    expect(() => selectVault(vaults)).toThrow(new RegExp(B, 'i'));
    expect(selectVault(vaults, B).VAULT).toBe(B);
  });
});

describe('dwell is wall clock', () => {
  it('uses DWELL_SECS verbatim when it is set', () => {
    const r = resolveDwellSecs({ DWELL_SECS: 1800, DWELL_BLOCKS: 900 }, 2.25);
    expect(r.secs).toBe(1800);
    expect(r.derived).toBe(false);
  });

  it('derives mainnet DWELL_BLOCKS=900 at ~2.25s/block as ~34 minutes', () => {
    // The interval mainnet has actually been enforcing. The derived default has
    // to land here or upgrading silently retunes a live anti-manipulation gate.
    const r = resolveDwellSecs({ DWELL_SECS: undefined, DWELL_BLOCKS: 900 }, 2.25);
    expect(r.secs).toBe(2025);
    expect(Math.round(r.secs / 60)).toBe(34);
    expect(r.derived).toBe(true);
    expect(r.note).toMatch(/DWELL_BLOCKS=900/);
  });

  it('derives the dev default of 3 blocks as a handful of seconds', () => {
    expect(resolveDwellSecs({ DWELL_SECS: undefined, DWELL_BLOCKS: 3 }, 2).secs).toBe(6);
  });

  it('never derives zero, however fast the chain is', () => {
    expect(resolveDwellSecs({ DWELL_SECS: undefined, DWELL_BLOCKS: 1 }, 0.001).secs).toBe(1);
  });

  it('is read per vault, so a different fee tier can hold a different gate', () => {
    process.env.VAULTS_JSON = JSON.stringify([
      { VAULT: A, DWELL_SECS: 2025 },
      { VAULT: B, DWELL_BLOCKS: 900 },
    ]);
    const { vaults } = loadKeeperConfig();
    expect(resolveDwellSecs(vaults[0], 2.25).secs).toBe(2025);
    expect(resolveDwellSecs(vaults[1], 2.25).secs).toBe(2025);
    expect(resolveDwellSecs(vaults[1], 6).secs).toBe(5400);
  });
});

describe('two vaults keep their state apart', () => {
  const vaultCtx = (dwellSecs: number) => ({ state: blankState(), dwellSecs, log: () => {} });

  it('arming vault A does not move vault B', () => {
    const a = vaultCtx(600);
    const b = vaultCtx(600);
    const t0 = 1_700_000_000;

    expect(stepDwell(a, 'dwellSince', true, t0, 'trigger')).toBe(false);
    expect(a.state.dwellSince).toBe(t0);
    expect(b.state.dwellSince).toBe(0);

    // B holds nothing on the same block; A keeps holding.
    expect(stepDwell(b, 'dwellSince', false, t0, 'trigger')).toBe(false);
    expect(stepDwell(a, 'dwellSince', true, t0 + 300, 'trigger')).toBe(false);
    expect(a.state.dwellSince).toBe(t0);
    expect(b.state.dwellSince).toBe(0);

    // A arms after its full window; B has still never started.
    expect(stepDwell(a, 'dwellSince', true, t0 + 600, 'trigger')).toBe(true);
    expect(stepDwell(b, 'dwellSince', true, t0 + 600, 'trigger')).toBe(false);
    expect(b.state.dwellSince).toBe(t0 + 600);
  });

  it('clears the clock when the trigger stops holding', () => {
    const a = vaultCtx(600);
    const t0 = 1_700_000_000;
    stepDwell(a, 'dwellSince', true, t0, 'trigger');
    stepDwell(a, 'dwellSince', false, t0 + 10, 'trigger');
    expect(a.state.dwellSince).toBe(0);
    // ...and starts a fresh window rather than resuming the old one
    expect(stepDwell(a, 'dwellSince', true, t0 + 20, 'trigger')).toBe(false);
    expect(stepDwell(a, 'dwellSince', true, t0 + 610, 'trigger')).toBe(false);
    expect(stepDwell(a, 'dwellSince', true, t0 + 620, 'trigger')).toBe(true);
  });

  it('keeps the rebalance and refresh clocks independent', () => {
    const a = vaultCtx(600);
    const t0 = 1_700_000_000;
    stepDwell(a, 'dwellSince', true, t0, 'trigger');
    stepDwell(a, 'refreshDwellSince', false, t0, 'refresh');
    expect(a.state.dwellSince).toBe(t0);
    expect(a.state.refreshDwellSince).toBe(0);
  });

  it('gives every vault its own price history and regime', () => {
    const a = blankState();
    const b = blankState();
    a.prices.push(1_700_000_000, 10);
    a.regime = { regime: 'extreme', since: 1_700_000_000 };
    expect(b.regime.regime).toBe('calm');
    expect(b.prices.moveOver(3600, 1_700_000_000)).toBeUndefined();
  });
});

describe('fold-at-balance is per-vault', () => {
  it('inherits the flat FOLD_* defaults and lets one vault opt out', () => {
    process.env.FOLD_ENABLED = 'true';
    process.env.FOLD_MIN_SHARE = '0.4';
    process.env.FOLD_MIN_LIMIT_SHARE = '0';
    // 16, not the schema default 10, so inheritance is distinguishable from
    // the second vault's override below.
    process.env.BASE_HALF_WIDTH_MULT = '16';
    process.env.VAULTS_JSON = JSON.stringify([
      { VAULT: A },
      { VAULT: B, FOLD_ENABLED: false, BASE_HALF_WIDTH_MULT: 10 },
    ]);
    const { vaults } = loadKeeperConfig();
    expect(vaults[0].FOLD_ENABLED).toBe(true);
    expect(vaults[0].FOLD_MIN_LIMIT_SHARE).toBe(0);
    expect(vaults[1].FOLD_ENABLED).toBe(false);
    // neither override may leak sideways
    expect(vaults[0].BASE_HALF_WIDTH_MULT).toBe(16);
    expect(vaults[1].BASE_HALF_WIDTH_MULT).toBe(10);
    expect(vaults[1].FOLD_MIN_SHARE).toBe(0.4);
  });

  it('keeps the fold dwell isolated between vaults', () => {
    const mk = () => ({ state: blankState(), dwellSecs: 100, log: () => {} });
    const a = mk();
    const b = mk();
    expect(stepDwell(a, 'foldDwellSince', true, 1_000, 'fold')).toBe(false);
    expect(a.state.foldDwellSince).toBe(1_000);
    // B has seen nothing; A's armed fold must not arm it
    expect(b.state.foldDwellSince).toBe(0);
    expect(stepDwell(b, 'foldDwellSince', true, 1_050, 'fold')).toBe(false);
    // A clears its dwell at 1100, B not until 1150
    expect(stepDwell(a, 'foldDwellSince', true, 1_100, 'fold')).toBe(true);
    expect(stepDwell(b, 'foldDwellSince', true, 1_100, 'fold')).toBe(false);
    expect(stepDwell(b, 'foldDwellSince', true, 1_150, 'fold')).toBe(true);
  });

  it('resets the fold dwell the moment the trigger clears', () => {
    const v = { state: blankState(), dwellSecs: 100, log: () => {} };
    stepDwell(v, 'foldDwellSince', true, 1_000, 'fold');
    expect(stepDwell(v, 'foldDwellSince', false, 1_050, 'fold')).toBe(false);
    expect(v.state.foldDwellSince).toBe(0);
  });
});

describe('PRIVATE_KEY_FILE', () => {
  const write = (body: string) => {
    const f = join(mkdtempSync(join(tmpdir(), 'keeperkey-')), 'key');
    writeFileSync(f, body);
    return f;
  };

  it('reads the signing key from the named file', () => {
    delete process.env.PRIVATE_KEY;
    process.env.PRIVATE_KEY_FILE = write(KEY);
    process.env.VAULT = A;
    expect(loadKeeperConfig().global.PRIVATE_KEY).toBe(KEY);
  });

  it('trims the trailing newline docker secret create leaves behind', () => {
    delete process.env.PRIVATE_KEY;
    process.env.PRIVATE_KEY_FILE = write(`${KEY}\n`);
    process.env.VAULT = A;
    expect(loadKeeperConfig().global.PRIVATE_KEY).toBe(KEY);
  });

  it('validates a file-supplied key exactly like an env one', () => {
    delete process.env.PRIVATE_KEY;
    process.env.PRIVATE_KEY_FILE = write('not-a-key');
    process.env.VAULT = A;
    expect(() => loadKeeperConfig()).toThrow(/0x \+ 64 hex/);
  });

  it('refuses to guess when both are set', () => {
    process.env.PRIVATE_KEY = KEY;
    process.env.PRIVATE_KEY_FILE = write(KEY);
    process.env.VAULT = A;
    expect(() => loadKeeperConfig()).toThrow(/both PRIVATE_KEY and PRIVATE_KEY_FILE/);
  });

  it('fails loudly on an unreadable or empty file', () => {
    delete process.env.PRIVATE_KEY;
    process.env.VAULT = A;
    process.env.PRIVATE_KEY_FILE = '/nonexistent/keeper.key';
    expect(() => loadKeeperConfig()).toThrow(/cannot read/);
    process.env.PRIVATE_KEY_FILE = write('   \n');
    expect(() => loadKeeperConfig()).toThrow(/file is empty/);
  });

  it('leaves the env path untouched when no file is named', () => {
    process.env.PRIVATE_KEY = KEY;
    process.env.VAULT = A;
    expect(loadKeeperConfig().global.PRIVATE_KEY).toBe(KEY);
  });
});
