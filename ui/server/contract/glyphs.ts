// what the vendored Perfect DOS VGA 437 Win.ttf can draw. the ranges are fc-scan's charset for
// static/tuicss/fonts/Perfect DOS VGA 437 Win.ttf (2026-09-18): 255 code points, nothing else.
// rings, fixtures and api bodies keep the raw glyphs; mapGlyphs() runs at render time only.
export const FONT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x01, 0x7f],
  [0xa0, 0xa3],
  [0xa5, 0xa5],
  [0xaa, 0xac],
  [0xb0, 0xb2],
  [0xb5, 0xb5],
  [0xb7, 0xb7],
  [0xba, 0xbd],
  [0xbf, 0xbf],
  [0xc4, 0xc7],
  [0xc9, 0xc9],
  [0xd1, 0xd1],
  [0xd6, 0xd6],
  [0xdc, 0xdc],
  [0xdf, 0xe2],
  [0xe4, 0xef],
  [0xf1, 0xf4],
  [0xf6, 0xf7],
  [0xf9, 0xfc],
  [0xff, 0xff],
  [0x192, 0x192],
  [0x393, 0x393],
  [0x398, 0x398],
  [0x3a3, 0x3a3],
  [0x3a6, 0x3a6],
  [0x3a9, 0x3a9],
  [0x3b1, 0x3b1],
  [0x3b4, 0x3b5],
  [0x3c0, 0x3c0],
  [0x3c3, 0x3c4],
  [0x3c6, 0x3c6],
  [0x207f, 0x207f],
  [0x20a7, 0x20a7],
  [0x2219, 0x221a],
  [0x221e, 0x221e],
  [0x2229, 0x2229],
  [0x2248, 0x2248],
  [0x2261, 0x2261],
  [0x2264, 0x2265],
  [0x2310, 0x2310],
  [0x2320, 0x2321],
  [0x2500, 0x2500],
  [0x2502, 0x2502],
  [0x250c, 0x250c],
  [0x2510, 0x2510],
  [0x2514, 0x2514],
  [0x2518, 0x2518],
  [0x251c, 0x251c],
  [0x2524, 0x2524],
  [0x252c, 0x252c],
  [0x2534, 0x2534],
  [0x253c, 0x253c],
  [0x2550, 0x256c],
  [0x2580, 0x2580],
  [0x2584, 0x2584],
  [0x2588, 0x2588],
  [0x258c, 0x258c],
  [0x2590, 0x2593],
  [0x25a0, 0x25a0],
];

export const FONT_CODEPOINTS = FONT_RANGES.reduce((n, [a, b]) => n + (b - a + 1), 0);

const esc = (cp: number) => `\\u{${cp.toString(16)}}`;
const CLASS = FONT_RANGES.map(([a, b]) => (a === b ? esc(a) : `${esc(a)}-${esc(b)}`)).join('');

// every code point of the string is one the font maps. the controls 0x01-0x1f are in: cp437
// draws them (smileys, cards, arrows) and the font keeps them; a rendered line never has one
export const GLYPH_WHITELIST = new RegExp(`^[${CLASS}]*$`, 'u');

// render-time substitutions: the keeper grammar's ✓ ⚠ — …, the arrows and bullets the font
// lacks, and the monitor's emoji. ⚠️ (U+26A0 U+FE0F) sits before the bare ⚠ so the selector
// never survives on its own
export const GLYPH_MAP: ReadonlyArray<readonly [string, string]> = [
  ['🛑', '!!'],
  ['⚠️', '!'],
  ['🎉', 'ok'],
  ['✓', '√'],
  ['⚠', '!'],
  ['—', '-'],
  ['…', '..'],
  ['×', 'x'],
  ['•', '·'],
  ['▲', '^'],
  ['▼', 'v'],
  ['→', '>'],
  ['←', '<'],
];

const MAP = new Map<string, string>(GLYPH_MAP);
const MAP_RE = new RegExp(
  GLYPH_MAP.map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'gu',
);

export function mapGlyphs(s: string): string {
  return s.replace(MAP_RE, (m) => MAP.get(m) ?? m);
}

export function isRenderable(s: string): boolean {
  return GLYPH_WHITELIST.test(s);
}

// the distinct characters the font cannot draw, for test failure messages
export function offenders(s: string): string[] {
  const out = new Set<string>();
  for (const ch of s) if (!GLYPH_WHITELIST.test(ch)) out.add(ch);
  return [...out];
}
