import type { Config } from './config';

export type Severity = 'critical' | 'warning' | 'recovered';
const EMOJI: Record<Severity, string> = { critical: '🛑', warning: '⚠️', recovered: '🎉' };

export interface Alert {
  at: string;
  severity: Severity;
  title: string;
}

/** second sink beside discord: the last ALERTS_MAX alerts, served by /status. */
export const ALERTS_MAX = 100;
const ring: Alert[] = [];

export function alerts(): Alert[] {
  return [...ring];
}

export function recordAlert(a: Alert): void {
  ring.push(a);
  if (ring.length > ALERTS_MAX) ring.splice(0, ring.length - ALERTS_MAX);
}

export type Notify = (sev: Severity, title: string, detail: string) => Promise<void>;

/** Never throws: a broken webhook must not take the watchdog down with it. */
export async function notify(cfg: Pick<Config, 'DISCORD_WEBHOOK'>, sev: Severity, title: string, detail: string): Promise<void> {
  recordAlert({ at: new Date().toISOString(), severity: sev, title });
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
