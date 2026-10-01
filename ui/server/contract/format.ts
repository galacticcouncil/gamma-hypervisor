// formatting shared by the verdict sentences and the text renderer. everything
// here is code-point aware (the box glyphs are single code points) and emits
// only characters the vendored font draws — no arrows, bullets or ellipses.

export function cps(s: string): string[] {
  return Array.from(s);
}

export function width(s: string): number {
  return cps(s).length;
}

export function padRight(s: string, w: number): string {
  const n = width(s);
  return n >= w ? s : s + ' '.repeat(w - n);
}

export function padLeft(s: string, w: number): string {
  const n = width(s);
  return n >= w ? s : ' '.repeat(w - n) + s;
}

// exactly w code points: truncated or right-padded
export function fit(s: string, w: number): string {
  const c = cps(s);
  if (c.length === w) return s;
  if (c.length > w) return c.slice(0, w).join('');
  return s + ' '.repeat(w - c.length);
}

export function fmtInt(n: number | bigint | null | undefined): string {
  if (n === null || n === undefined) return '-';
  const s = typeof n === 'bigint' ? n.toString() : Math.trunc(n).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function fmtNum(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '-';
  const abs = Math.abs(x);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e9)) return x.toExponential(1);
  const s = Math.abs(x).toFixed(digits);
  const [i, f] = s.split('.');
  const sign = x < 0 && Number(s) !== 0 ? '-' : '';
  return sign + (f ? `${fmtInt(Number(i))}.${f}` : fmtInt(Number(i)));
}

// fraction → `+3.30%` / `-4.35%`; null → `-`
export function fmtPct(frac: number | null | undefined, digits = 2, sign = true): string {
  if (frac === null || frac === undefined || !Number.isFinite(frac)) return '-';
  const v = frac * 100;
  const s = v.toFixed(digits);
  return sign && v > 0 ? `+${s}%` : `${s}%`;
}

// `2h04m`, `34m`, `12s`, `2d3h`
export function fmtDur(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || !Number.isFinite(secs)) return '-';
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h${String(m).padStart(2, '0')}m`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h ? `${d}d${h}h` : `${d}d`;
}

// one unit only: `2s` `34m` `9h` `2d`
export function fmtDurShort(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || !Number.isFinite(secs)) return '-';
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// `0x0B0b..Cb96`
export function fmtAddr(a: string | null | undefined): string {
  if (!a) return '-';
  return a.length > 12 ? `${a.slice(0, 6)}..${a.slice(-4)}` : a;
}

// `0x8f3a..c1`
export function fmtHash(h: string | null | undefined): string {
  if (!h) return '-';
  return h.length > 10 ? `${h.slice(0, 6)}..${h.slice(-2)}` : h;
}

export function weiToNum(wei: string | bigint | null | undefined, decimals = 18): number | null {
  if (wei === null || wei === undefined) return null;
  try {
    const b = typeof wei === 'bigint' ? wei : BigInt(wei);
    const neg = b < 0n;
    const abs = neg ? -b : b;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    const frac = abs % base;
    const v = Number(whole) + Number(frac) / Number(base);
    return neg ? -v : v;
  } catch {
    return null;
  }
}

// `0.00172`
export function fmtWei(wei: string | bigint | null | undefined, decimals = 18, digits = 5): string {
  const v = weiToNum(wei, decimals);
  if (v === null) return '-';
  if (v !== 0 && Math.abs(v) < 10 ** -digits) return v.toExponential(1);
  return v.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '.0');
}

export function fmtClock(t: number | string | Date | null | undefined): string {
  if (t === null || t === undefined) return '-';
  const d = t instanceof Date ? t : new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : t);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toISOString().slice(11, 19);
}

// `01:03`
export function fmtHm(t: number | string | Date | null | undefined): string {
  const s = fmtClock(t);
  return s === '-' ? s : s.slice(0, 5);
}

// `09-16 23:54`
export function fmtDate(t: number | string | Date | null | undefined): string {
  if (t === null || t === undefined) return '-';
  const d = t instanceof Date ? t : new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : t);
  if (Number.isNaN(d.getTime())) return '-';
  const iso = d.toISOString();
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

// `███████░░░`
export function bar(frac: number | null | undefined, w = 10, fill = '█', empty = '░'): string {
  if (frac === null || frac === undefined || !Number.isFinite(frac)) return '─'.repeat(w);
  const n = Math.max(0, Math.min(w, Math.round(Math.max(0, Math.min(1, frac)) * w)));
  return fill.repeat(n) + empty.repeat(w - n);
}

// `aDOT/HOLLAR` → `adot-hollar`
export function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function secs(ms: number): number {
  return Math.floor(ms / 1000);
}

export function isoToSecs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
