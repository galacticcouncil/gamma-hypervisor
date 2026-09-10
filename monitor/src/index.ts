import { ethers } from 'ethers';
import { loadConfig } from './config';
import { runChecks, type Memo, type Finding } from './checks';
import { notify } from './notify';

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
 */
const cfg = loadConfig();
const provider = new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
const memo: Memo = {};
const firing = new Map<string, { at: number; f: Finding }>();

async function cycle(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let findings: Finding[];
  try {
    findings = await runChecks(cfg, provider, memo);
  } catch (e) {
    // An RPC blip must not look like a healthy chain, nor kill the loop.
    console.log(`check cycle failed: ${(e as Error).message}`);
    return;
  }
  const seen = new Set(findings.map((f) => f.key));

  for (const f of findings) {
    const prev = firing.get(f.key);
    if (!prev) {
      firing.set(f.key, { at: now, f });
      await notify(cfg, f.severity, f.title, f.detail);
    } else if (now - prev.at >= cfg.REALERT_SECS) {
      firing.set(f.key, { at: now, f });
      await notify(cfg, f.severity, f.title, `${f.detail}\n(still firing after ${Math.round((now - prev.at) / 3600)}h)`);
    }
  }
  for (const [key, prev] of [...firing]) {
    if (seen.has(key)) continue;
    firing.delete(key);
    await notify(cfg, 'recovered', `Resolved: ${prev.f.title}`, 'Condition no longer detected.');
  }
  if (!findings.length) console.log(`ok — nothing firing (nonce ${memo.lastNonce})`);
}

console.log(`gamma monitor: ${cfg.RPC_URL}, every ${cfg.CHECK_INTERVAL_SECS}s, webhook ${cfg.DISCORD_WEBHOOK ? 'set' : 'NOT set (log only)'}`);
await cycle();
if (cfg.ONCE !== 'true') setInterval(() => { void cycle(); }, cfg.CHECK_INTERVAL_SECS * 1000);
