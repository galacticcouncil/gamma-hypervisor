import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { loadConfig } from './config';
import { checkGas, runChecks, type Finding } from './checks';
import { describePool, ethersReader, loadPoolSpecs, resolvePools } from './pools';
import { notify } from './notify';
import { createState, noteCycle, reconcile, rpcFailingFinding, scrub, setPools, startStatus } from './status';

/**
 * Watchdog for the Gamma keeper.
 *
 * Deliberately a SIBLING of the keeper rather than part of it: the failure that
 * matters most is the keeper not running at all, and a health check inside the
 * process it is checking cannot report that. Every signal here is read from
 * chain, so it holds whether the keeper is healthy, crashed, or deleted.
 *
 * Alerts are edge-triggered — fire on transition, repeat only every
 * REALERT_SECS, and send one recovery message when the condition clears.
 *
 * Liveness is deliberately NOT "has the keeper sent a transaction lately". A
 * healthy keeper is silent for days, and an earlier nonce-based check produced
 * a day of false criticals on a keeper that was working correctly throughout.
 * What is checked instead is work that was DUE and did not happen.
 *
 * `firing` lives in memory: every boot's first cycle re-notifies whatever is
 * currently firing as new. Accepted — restarts are rare once nothing can
 * healthcheck-kill this process.
 */
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
const cfg = loadConfig();
// a socket that accepts and never answers would otherwise wedge the loop for good
const provider = new ethers.providers.JsonRpcProvider({ url: cfg.RPC_URL, timeout: 30_000 });
const { source, specs } = loadPoolSpecs(cfg);
const state = createState({ version, source, specs });
const send = (sev: Parameters<typeof notify>[1], title: string, detail: string) => notify(cfg, sev, title, detail);

if (cfg.STATUS_PORT > 0) startStatus(state, cfg, cfg.STATUS_PORT);

console.log(
  `gamma monitor ${version}: ${cfg.rpcHost}, every ${cfg.CHECK_INTERVAL_SECS}s, webhook ${cfg.DISCORD_WEBHOOK ? 'set' : 'NOT set (log only)'}, ` +
    `status ${cfg.STATUS_PORT > 0 ? `:${cfg.STATUS_PORT} (overlay only)` : 'off'}, rpc alert after ${cfg.FAIL_ALERT_CYCLES || 'never'} failed cycles`,
);
console.log(`pools from ${source}:`);
for (const s of specs) console.log(`  ${describePool(s)}`);

let busy = false;

async function cycle(): Promise<void> {
  if (busy) {
    console.log('previous cycle still running, skipping');
    return;
  }
  busy = true;
  try {
    await cycleInner();
  } finally {
    busy = false;
  }
}

async function cycleInner(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const findings: Finding[] = [];
  const checked = new Set<string>();
  let gasOk = false;
  let lastError: string | null = null;
  const fail = (what: string, e: unknown) => {
    lastError = scrub(`${what}: ${(e as Error).message}`, cfg);
    console.log(`check failed — ${lastError}`);
  };

  // decimals and pool addresses are read once; until that read lands nothing else can run
  if (state.pools.some((p) => p.pool === null)) {
    try {
      const pools = await resolvePools(specs, ethersReader(provider));
      setPools(state, pools);
      for (const p of pools) console.log(`  ${p.label}: pool ${p.pool}, ${p.sym0} ${p.dec0} dec / ${p.sym1} ${p.dec1} dec`);
    } catch (e) {
      fail('resolving pools', e);
    }
  }

  if (state.pools.every((p) => p.pool !== null)) {
    try {
      const g = await checkGas(cfg.KEEPER, cfg.gasWarn, cfg.gasFloor, provider);
      state.gasWei = g.wei;
      gasOk = true;
      if (g.finding) findings.push(g.finding);
    } catch (e) {
      fail('gas', e);
    }
    for (const ps of state.pools) {
      try {
        const r = await runChecks(ps.pool!, provider, ps.memo);
        ps.snapshot = r.snapshot;
        checked.add(ps.spec.id);
        findings.push(...r.findings);
      } catch (e) {
        // an rpc blip must not look like a healthy chain, nor kill the loop
        ps.memo.failures += 1;
        fail(ps.pool!.label, e);
      }
    }
  }

  const cycleOk = gasOk && checked.size === state.pools.length;
  noteCycle(state, cycleOk, now, lastError);
  const rpc = rpcFailingFinding(state, cfg);
  if (rpc) findings.push(rpc);

  await reconcile(state, { findings, checked, gasOk, cycleOk }, cfg, send, now);
  if (cycleOk && !findings.length) console.log('ok — nothing firing');
}

await cycle();
if (cfg.ONCE !== 'true') setInterval(() => { void cycle(); }, cfg.CHECK_INTERVAL_SECS * 1000);
