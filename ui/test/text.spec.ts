import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfig } from '../server/config';
import { setDb, type Db } from '../server/db/index';
import { ctx, setSources, statusBody, vaultDetail, listVaults } from '../server/contract/serialize';
import { DRILL_KEYS, FLEET_KEYS, keyBar, linesOf, menuLine, renderFleet, renderVault, ruler, WIDTH } from '../server/contract/text';
import { FONT_CODEPOINTS, GLYPH_MAP, isRenderable, offenders } from '../server/contract/glyphs';
import { blockingWord } from '../server/contract/cells';
import { fleetText as fleetTextJs, vaultText as vaultTextJs } from '../src/lib/utils/text.js';

// the page renderers are plain js: their parameter shapes are inferred, not declared
const fleetText = fleetTextJs as unknown as (s: unknown, o: { now: number }) => string[];
const vaultText = vaultTextJs as unknown as (v: unknown, s: unknown, o: { now: number }) => string[];
import { chainState, keeperState, monitorState, seedDb, testConfig, VAULT_LABEL } from './fixtures';

// the 78-column contract: every emitted line is exactly 78 code points and
// draws only what the vendored Perfect DOS VGA 437 has.

const cfg = testConfig();
let db: Db;

const check = (screen: string, label: string, min = 8): void => {
  const lines = linesOf(screen).filter((l) => l.length > 0);
  expect(lines.length).toBeGreaterThan(min);
  for (const l of lines) {
    expect([label, l, [...l].length]).toEqual([label, l, WIDTH]);
    expect([label, l, offenders(l)]).toEqual([label, l, []]);
  }
};

beforeEach(() => {
  setConfig(cfg);
  db = seedDb();
  setDb(db);
  setSources({ keeper: keeperState(), monitor: monitorState(), chain: chainState() });
});

afterEach(() => {
  setSources(null);
  setDb(null);
  db.close();
  setConfig(null);
});

describe('text screens', () => {
  it('renders the fleet at 78 columns, f-key bar included', () => {
    const c = ctx();
    const screen = renderFleet(statusBody(c), { nowMs: c.nowMs });
    check(screen, 'fleet');
    const lines = screen.split('\n');
    expect(lines[0]).toMatch(/UTC$/);
    expect(lines[1]).toBe(`┌${'─'.repeat(76)}┐`);
    expect(lines.some((l) => l.includes(VAULT_LABEL))).toBe(true);
    expect(lines[lines.length - 1].endsWith('█')).toBe(true);
    expect([...lines[lines.length - 1]]).toHaveLength(WIDTH);
  });

  it('renders the vault drill at 78 columns', () => {
    const c = ctx();
    const row = listVaults(c.db)[0];
    const screen = renderVault(vaultDetail(c, row), { index: 1, total: 1, nowMs: c.nowMs });
    check(screen, 'vault');
    const lines = screen.split('\n');
    expect(lines[1].startsWith('╔═ ')).toBe(true);
    expect(lines.some((l) => l.includes('keeper says'))).toBe(true);
    expect(lines.some((l) => l.includes('chain says'))).toBe(true);
    expect(lines.some((l) => l.startsWith('╚'))).toBe(true);
    expect(lines[lines.length - 1]).toBe(keyBar(DRILL_KEYS));
  });

  it('stays 78 wide with no vaults, no chain sample and no keeper', () => {
    db.run('DELETE FROM samples');
    setSources({ keeper: keeperState({ reachable: false, status: null, statusAt: null }), monitor: monitorState({ reachable: false }), chain: null });
    const c = ctx();
    const row = listVaults(c.db)[0];
    check(renderVault(vaultDetail(c, row), { nowMs: c.nowMs }), 'vault-empty');
    db.run('DELETE FROM vaults');
    check(renderFleet(statusBody(ctx()), { nowMs: c.nowMs }), 'fleet-empty');
  });

  it('truncates an over-long label instead of widening the row', () => {
    db.run('UPDATE vaults SET label = :l', { l: 'a-very-long-pair-label/that-would-blow-the-grid' });
    const c = ctx();
    check(renderFleet(statusBody(c), { nowMs: c.nowMs }), 'fleet-long');
  });

  it('covers exactly what fc-scan found in the vendored font', () => {
    // static/tuicss/ORIGIN.md: 255 code points. a range edited without re-scanning
    // the font is the failure this pins
    expect(FONT_CODEPOINTS).toBe(255);
  });

  it('maps the keeper grammar glyphs the font lacks, at render time only', () => {
    for (const [from, to] of GLYPH_MAP) {
      expect(isRenderable(from)).toBe(false);
      expect(isRenderable(to)).toBe(true);
    }
    const c = ctx();
    const screen = renderFleet(statusBody(c), { nowMs: c.nowMs });
    for (const [from] of GLYPH_MAP) expect(screen.includes(from)).toBe(false);
  });

  // `?agent=1` is rendered client-side from the same bodies; it is held to the
  // same contract as the server screens (plan › ui: any page renders art-free)
  it('renders the page agent screens at 78 columns and in the font', () => {
    const c = ctx();
    const s = statusBody(c);
    check(fleetText(s, { now: c.nowMs }).join('\n'), 'agent-fleet', 4);
    const row = listVaults(c.db)[0];
    check(vaultText(vaultDetail(c, row), s, { now: c.nowMs }).join('\n'), 'agent-vault', 4);
  });

  it('draws one blocking cell: the server screen and the page agree', () => {
    const c = ctx();
    const s = statusBody(c);
    const v = s.vaults[0];
    expect(blockingWord(v)).toBe('clamp 111>50');
    expect(renderFleet(s, { nowMs: c.nowMs })).toContain(blockingWord(v));
  });

  it('pads the menu, the f-key bars and the ruler to the same width', () => {
    expect([...menuLine(Date.now())]).toHaveLength(WIDTH);
    expect([...keyBar(FLEET_KEYS)]).toHaveLength(WIDTH);
    expect([...keyBar(DRILL_KEYS)]).toHaveLength(WIDTH);
    const [band, marks] = ruler(184860, 186840, { spot: 185062, twap: 184985, oracle: 185096, mid: 185850 }, 40);
    expect([...band]).toHaveLength(42); // 40 cells between ├ ┤
    expect(band.startsWith('├')).toBe(true);
    expect(band.endsWith('┤')).toBe(true);
    expect(band).toContain('■');
    expect(marks).toContain('t');
    expect(marks).toContain('o');
    expect(marks).toContain('m');
    expect(isRenderable(band)).toBe(true);
  });
});
