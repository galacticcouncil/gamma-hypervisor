import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { ERC20_ABI, HYPERVISOR_ABI } from '@keeper/abis';
import type { Db } from '../db/index';
import { log, nowSec } from './util';

// vaults.json: one array of flat entries, keeper VAULT_KEYS plus LABEL,
// MONITOR_* and UI_* siblings. unknown keys are kept as-is for the config
// screen; nothing secret-shaped is ever loaded, so the descriptor can be
// published verbatim.

export type ScalarValue = string | number | boolean | null;

export interface DescriptorVault {
  // lowercase VAULT address
  id: string;
  label: string;
  startBlock: number | null;
  entry: Record<string, ScalarValue>;
}

export interface Descriptor {
  sha256: string;
  vaults: DescriptorVault[];
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SECRET_KEY_RE = /PRIVATE_KEY|WEBHOOK|SECRET|PASSWORD/i;
const HEX64_RE = /^(0x)?[0-9a-fA-F]{64}$/;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function slugOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function scalar(v: unknown): ScalarValue | undefined {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v as ScalarValue;
  return undefined;
}

export function parseDescriptor(text: string): Descriptor {
  const json: unknown = JSON.parse(text);
  const list = Array.isArray(json)
    ? json
    : json !== null && typeof json === 'object' && Array.isArray((json as { vaults?: unknown }).vaults)
      ? (json as { vaults: unknown[] }).vaults
      : null;
  if (!list) throw new Error('descriptor: expected an array of vault entries (or {vaults: [...]})');

  const vaults: DescriptorVault[] = [];
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  list.forEach((raw, i) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`descriptor[${i}]: not an object`);
    const entry: Record<string, ScalarValue> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) continue;
      const s = scalar(v);
      if (s === undefined) continue; // nested values are not descriptor material
      if (typeof s === 'string' && HEX64_RE.test(s)) continue; // key-shaped, never load
      entry[k] = s;
    }
    const vault = entry.VAULT;
    if (typeof vault !== 'string' || !ADDRESS_RE.test(vault)) throw new Error(`descriptor[${i}]: VAULT must be an address`);
    const id = vault.toLowerCase();
    if (seenIds.has(id)) throw new Error(`descriptor[${i}]: duplicate VAULT`);
    seenIds.add(id);
    const label = typeof entry.LABEL === 'string' && entry.LABEL.trim() ? entry.LABEL.trim() : `${id.slice(0, 6)}..${id.slice(-4)}`;
    if (seenLabels.has(label)) throw new Error(`descriptor[${i}]: duplicate LABEL`);
    seenLabels.add(label);
    const sb = entry.UI_START_BLOCK;
    const startBlock = typeof sb === 'number' && Number.isInteger(sb) && sb >= 0 ? sb : typeof sb === 'string' && /^\d+$/.test(sb) ? Number(sb) : null;
    vaults.push({ id, label, startBlock, entry });
  });
  return { sha256: sha256(text), vaults };
}

// throws with the rule, never the file contents; the path is process-log only
export function loadDescriptor(path: string): Descriptor {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error('VAULTS_FILE not readable');
  }
  return parseDescriptor(text);
}

export type VaultRow = {
  id: string;
  label: string;
  pool: string | null;
  token0: string | null;
  token1: string | null;
  dec0: number | null;
  dec1: number | null;
  sym0: string | null;
  sym1: string | null;
  tick_spacing: number | null;
  entrypoint: string | null;
  start_block: number | null;
  first_seen_at: number | null;
  descriptor_json: string | null;
}

interface ChainIdentity {
  pool: string;
  token0: string;
  token1: string;
  tickSpacing: number;
  dec0: number | null;
  dec1: number | null;
  sym0: string | null;
  sym1: string | null;
}

async function readIdentity(provider: ethers.providers.Provider, id: string): Promise<ChainIdentity> {
  const vault = new ethers.Contract(id, HYPERVISOR_ABI, provider);
  const [pool, token0, token1, tickSpacing] = await Promise.all([vault.pool(), vault.token0(), vault.token1(), vault.tickSpacing()]);
  const t0 = new ethers.Contract(token0, ERC20_ABI, provider);
  const t1 = new ethers.Contract(token1, ERC20_ABI, provider);
  // decimals drive every human number; symbols are cosmetic — both best-effort here,
  // the sampler refuses to price a vault whose decimals stayed null
  const [dec0, dec1, sym0, sym1] = await Promise.all([
    t0.decimals().then(Number).catch(() => null),
    t1.decimals().then(Number).catch(() => null),
    t0.symbol().catch(() => null),
    t1.symbol().catch(() => null),
  ]);
  return {
    pool: String(pool).toLowerCase(),
    token0: String(token0).toLowerCase(),
    token1: String(token1).toLowerCase(),
    tickSpacing: Number(tickSpacing),
    dec0,
    dec1,
    sym0,
    sym1,
  };
}

const UPSERT = `INSERT INTO vaults (id, label, pool, token0, token1, dec0, dec1, sym0, sym1, tick_spacing, entrypoint, start_block, first_seen_at, descriptor_json)
VALUES (:id, :label, :pool, :token0, :token1, :dec0, :dec1, :sym0, :sym1, :tick_spacing, :entrypoint, :start_block, :first_seen_at, :descriptor_json)
ON CONFLICT (id) DO UPDATE SET
  label = excluded.label,
  pool = COALESCE(excluded.pool, vaults.pool),
  token0 = COALESCE(excluded.token0, vaults.token0),
  token1 = COALESCE(excluded.token1, vaults.token1),
  dec0 = COALESCE(excluded.dec0, vaults.dec0),
  dec1 = COALESCE(excluded.dec1, vaults.dec1),
  sym0 = COALESCE(excluded.sym0, vaults.sym0),
  sym1 = COALESCE(excluded.sym1, vaults.sym1),
  tick_spacing = COALESCE(excluded.tick_spacing, vaults.tick_spacing),
  entrypoint = excluded.entrypoint,
  start_block = COALESCE(excluded.start_block, vaults.start_block),
  descriptor_json = excluded.descriptor_json`;

// upsert the descriptor into `vaults`; token identity is read from chain once
// (only for rows that still lack it) and kept forever
export async function upsertVaults(db: Db, desc: Descriptor, provider: ethers.providers.Provider | null, now = nowSec()): Promise<VaultRow[]> {
  for (const v of desc.vaults) {
    const existing = db.get<VaultRow>('SELECT * FROM vaults WHERE id = :id', { id: v.id });
    let ident: ChainIdentity | null = null;
    if (provider && (!existing || existing.pool === null || existing.dec0 === null || existing.dec1 === null)) {
      try {
        ident = await readIdentity(provider, v.id);
      } catch (e) {
        log('descriptor', `${v.label}: token identity not readable yet, will retry`);
      }
    }
    db.run(UPSERT, {
      id: v.id,
      label: v.label,
      pool: ident?.pool ?? null,
      token0: ident?.token0 ?? null,
      token1: ident?.token1 ?? null,
      dec0: ident?.dec0 ?? null,
      dec1: ident?.dec1 ?? null,
      sym0: ident?.sym0 ?? null,
      sym1: ident?.sym1 ?? null,
      tick_spacing: ident?.tickSpacing ?? null,
      entrypoint: typeof v.entry.ENTRYPOINT === 'string' ? v.entry.ENTRYPOINT : 'direct',
      start_block: v.startBlock,
      first_seen_at: existing?.first_seen_at ?? now,
      descriptor_json: JSON.stringify(v.entry),
    });
  }
  db.metaSet('descriptor_sha256', desc.sha256);
  db.metaSetJson(
    'descriptor_order',
    desc.vaults.map((v) => v.id),
  );
  return listVaults(db);
}

// descriptor order (matches the keeper log), then anything the descriptor dropped
export function listVaults(db: Db): VaultRow[] {
  const rows = db.all<VaultRow>('SELECT * FROM vaults');
  const order = db.metaGetJson<string[]>('descriptor_order') ?? [];
  const pos = new Map(order.map((id, i) => [id, i]));
  return rows.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9) || a.id.localeCompare(b.id));
}

// `{id}` in a url: lowercase address or label slug
export function findVault(db: Db, idOrSlug: string): VaultRow | null {
  const key = idOrSlug.toLowerCase();
  for (const v of listVaults(db)) if (v.id === key || slugOf(v.label) === key) return v;
  return null;
}

export function descriptorEntry(db: Db, id: string): Record<string, ScalarValue> {
  const row = db.get<{ descriptor_json: string | null }>('SELECT descriptor_json FROM vaults WHERE id = :id', { id });
  if (!row?.descriptor_json) return {};
  try {
    return JSON.parse(row.descriptor_json) as Record<string, ScalarValue>;
  } catch {
    return {};
  }
}
