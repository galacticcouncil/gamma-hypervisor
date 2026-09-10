import type { Config } from './config';

export type Severity = 'critical' | 'warning' | 'recovered';
const EMOJI: Record<Severity, string> = { critical: '🛑', warning: '⚠️', recovered: '🎉' };

/** Never throws: a broken webhook must not take the watchdog down with it. */
export async function notify(cfg: Config, sev: Severity, title: string, detail: string): Promise<void> {
  const line = `${EMOJI[sev]} **${title}**\n${detail}`;
  console.log(`[${sev}] ${title} — ${detail}`);
  if (!cfg.DISCORD_WEBHOOK) return;
  try {
    const res = await fetch(cfg.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: line.slice(0, 1900) }),
    });
    if (!res.ok) console.log(`  webhook returned ${res.status}`);
  } catch (e) {
    console.log(`  webhook failed: ${(e as Error).message}`);
  }
}
