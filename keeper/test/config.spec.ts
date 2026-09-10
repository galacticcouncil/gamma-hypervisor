import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config';

const KEY = '0x' + '11'.repeat(32);
const ADDR = '0x' + 'ab'.repeat(20);

let saved: NodeJS.ProcessEnv;

// loadConfig reads process.env directly; isolate each case from the developer's
// own .env (dotenv has already populated it by import time).
beforeEach(() => {
  saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (/^(RPC_URL|PRIVATE_KEY|VAULT|ENTRYPOINT|REBALANCE_PROXY|FEE_RECIPIENT|TWAP_|MIN_TWAP|MAX_DEV|ALLOW_UNSAFE|ORACLE_|DRY_RUN|MINS_|DWELL_|MIN_INTERVAL|BASE_|LIMIT_|REBALANCE_THRESHOLD|GAS_|CONFIRMATIONS|POLL_|STARTUP_)/.test(k)) {
      delete process.env[k];
    }
  }
  process.env.PRIVATE_KEY = KEY;
});

afterEach(() => {
  process.env = saved;
});

const live = () => {
  process.env.DRY_RUN = 'false';
  process.env.FEE_RECIPIENT = ADDR;
};

describe('config safety defaults', () => {
  it('defaults to the hardened gate settings', () => {
    live();
    const c = loadConfig();
    expect(c.TWAP_ENABLED).toBe(true);
    expect(c.MIN_INTERVAL_SECS).toBe(600);
    expect(c.DWELL_BLOCKS).toBeGreaterThan(1);
    expect(c.MINS_TOLERANCE_BPS).toBeGreaterThan(0);
    expect(c.ALLOW_UNSAFE_SPOT).toBe(false);
  });

  it('parses "false" as false rather than truthy-string true', () => {
    live();
    process.env.TWAP_ENABLED = 'false';
    process.env.ALLOW_UNSAFE_SPOT = 'true';
    expect(loadConfig().TWAP_ENABLED).toBe(false);
  });
});

describe('config refuses unsafe combinations', () => {
  it('rejects a live run with the TWAP gate off', () => {
    live();
    process.env.TWAP_ENABLED = 'false';
    expect(() => loadConfig()).toThrow(/TWAP/);
  });

  it('allows TWAP off only with the explicit local escape hatch', () => {
    live();
    process.env.TWAP_ENABLED = 'false';
    process.env.ALLOW_UNSAFE_SPOT = 'true';
    expect(() => loadConfig()).not.toThrow();
  });

  it('allows TWAP off in DRY_RUN (nothing is sent)', () => {
    process.env.DRY_RUN = 'true';
    process.env.TWAP_ENABLED = 'false';
    expect(() => loadConfig()).not.toThrow();
  });

  it('rejects a live run without an explicit fee recipient', () => {
    process.env.DRY_RUN = 'false';
    expect(() => loadConfig()).toThrow(/FEE_RECIPIENT|Treasury/);
  });

  it('rejects proxy mode without a proxy address', () => {
    live();
    process.env.ENTRYPOINT = 'proxy';
    expect(() => loadConfig()).toThrow(/REBALANCE_PROXY|required/);
  });

  it('accepts proxy mode with a proxy address', () => {
    live();
    process.env.ENTRYPOINT = 'proxy';
    process.env.REBALANCE_PROXY = ADDR;
    expect(loadConfig().ENTRYPOINT).toBe('proxy');
  });

  it('rejects an enabled oracle with no feed configured', () => {
    live();
    process.env.ORACLE_ENABLED = 'true';
    expect(() => loadConfig()).toThrow(/ORACLE/);
  });

  it('accepts an enabled oracle with a feed address', () => {
    live();
    process.env.ORACLE_ENABLED = 'true';
    process.env.ORACLE_FEED0 = ADDR;
    expect(loadConfig().ORACLE_FEED0).toBe(ADDR);
  });

  it('does not require a second feed — token1 may be the USD side', () => {
    live();
    process.env.ORACLE_ENABLED = 'true';
    process.env.ORACLE_FEED0 = ADDR;
    expect(loadConfig().ORACLE_FEED1).toBeUndefined();
  });
});
