// text-mode charts, copied from rpc-status helpers.js. columns are quantized to
// half-cell steps and drawn with the CP437 block characters the vendored font
// has (█ full, ▄ lower half, ▀ upper half, ░ ▒ ▓ shades) — there is no finer
// vertical resolution in text mode, and no other block glyph in the font.
export const CHART_GLYPHS = '▄█▀░▒▓';

// evenly spaced sample that always keeps the first and last point
export function sampleSeries(data, max = 48) {
  if (!Array.isArray(data) || max < 1) return [];
  if (data.length <= max) return [...data];
  if (max === 1) return [data[data.length - 1]];

  const step = (data.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i += 1) {
    out.push(data[Math.round(i * step)]);
  }
  return out;
}

function toTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// oldest first, then thinned to the column count
export function sortAndSample(data, max = 48) {
  if (!data || data.length === 0) return [];
  const sorted = [...data].sort((a, b) => toTime(a.time) - toTime(b.time));
  return sampleSeries(sorted, max);
}

// y ceiling: a round number just above the peak, never a fixed floor that
// squashes the normal readings into the bottom of the bed
export function niceMax(data, fallback = 1) {
  const peak = Math.max(...(data ?? []).map((d) => (Number.isFinite(d.value) ? d.value : 0)), 0);
  if (peak <= 0) return fallback;

  const padded = peak * 1.1;
  const step = Math.pow(10, Math.floor(Math.log10(padded))) / 2;
  // sub-1 steps leave binary dust (0.9500000000000001) on an axis label
  return Number((Math.ceil(padded / step) * step).toPrecision(12));
}

// columns of `halves` (0..rows*2) for a series of { time, value, error }
export function textChartColumns(data, { cols = 32, rows = 12, max: fixedMax } = {}) {
  const sampled = sortAndSample(data, cols);
  const max = fixedMax ?? niceMax(sampled);

  return {
    max,
    rows,
    columns: sampled.map((d) => {
      const value = Math.max(0, Math.min(Number.isFinite(d.value) ? d.value : 0, max));
      // anything measured shows at least a half block
      const halves = value > 0 ? Math.max(1, Math.round((value / max) * rows * 2)) : 0;
      return { halves, error: !!d.error, time: d.time, value: d.value };
    }),
  };
}

// the character at rowFromBottom (0 = baseline row) for a column of `halves`
export function textChartCell(halves, rowFromBottom) {
  const full = Math.floor(halves / 2);
  if (rowFromBottom < full) return '█';
  if (rowFromBottom === full && halves % 2 === 1) return '▄';
  return ' ';
}

// the whole bed as strings, top row first — for <pre> in the browser and for text.ts
export function textChartRows(chart, { blank = ' ' } = {}) {
  const out = [];
  for (let row = chart.rows - 1; row >= 0; row -= 1) {
    out.push(
      chart.columns
        .map((c) => textChartCell(c.halves, row))
        .join('')
        .replace(/ /g, blank)
    );
  }
  return out;
}

// one cell carrying two series: upper half for a, lower half for b
export function halfBlock(upper, lower) {
  if (upper && lower) return '█';
  if (upper) return '▀';
  if (lower) return '▄';
  return ' ';
}
