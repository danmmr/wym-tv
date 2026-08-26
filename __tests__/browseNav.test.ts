import {
  navKeyboard,
  scrollTopFor,
  KeyCell,
  visibleTabs,
  ALL_TABS,
  TABS,
} from '../src/screens/browseNav';

// Mirrors the real layout: four ragged letter rows then a 3-key action row.
const letters = (s: string): KeyCell[] => s.split('').map(c => ({l: c, v: c}));
const ROWS: KeyCell[][] = [
  letters('ABCDEFG'),
  letters('HIJKLMN'),
  letters('OPQRSTU'),
  letters('VWXYZ'),
  [
    {l: 'SPACE', v: ' ', act: 'space'},
    {l: 'DEL', v: '', act: 'del'},
    {l: 'CLEAR', v: '', act: 'clear'},
  ],
];

describe('navKeyboard', () => {
  it('moves within a row', () => {
    expect(navKeyboard(ROWS, {row: 0, col: 2}, 'right')).toEqual({
      kind: 'move',
      pos: {row: 0, col: 3},
    });
    expect(navKeyboard(ROWS, {row: 0, col: 2}, 'left')).toEqual({
      kind: 'move',
      pos: {row: 0, col: 1},
    });
  });

  it('reports an edge instead of wrapping', () => {
    expect(navKeyboard(ROWS, {row: 0, col: 0}, 'left')).toEqual({
      kind: 'exitLeft',
    });
    expect(navKeyboard(ROWS, {row: 0, col: 6}, 'right')).toEqual({
      kind: 'exitRight',
    });
    expect(navKeyboard(ROWS, {row: 0, col: 3}, 'up')).toEqual({kind: 'exitUp'});
    expect(navKeyboard(ROWS, {row: 4, col: 1}, 'down')).toEqual({
      kind: 'exitDown',
    });
  });

  it('clamps the column when moving into a shorter row', () => {
    // 'U' is column 6 of a 7-wide row; the row below has only 5 keys.
    expect(navKeyboard(ROWS, {row: 2, col: 6}, 'down')).toEqual({
      kind: 'move',
      pos: {row: 3, col: 4},
    });
    // And into the 3-key action row.
    expect(navKeyboard(ROWS, {row: 3, col: 4}, 'down')).toEqual({
      kind: 'move',
      pos: {row: 4, col: 2},
    });
  });

  it('does not push the column back out when moving up again', () => {
    // Landing clamped and going back up must stay in bounds, not restore the
    // original wider column.
    expect(navKeyboard(ROWS, {row: 4, col: 2}, 'up')).toEqual({
      kind: 'move',
      pos: {row: 3, col: 2},
    });
  });

  it('returns the pressed key on select', () => {
    expect(navKeyboard(ROWS, {row: 0, col: 0}, 'select')).toEqual({
      kind: 'press',
      key: {l: 'A', v: 'A'},
    });
    expect(navKeyboard(ROWS, {row: 4, col: 1}, 'select')).toEqual({
      kind: 'press',
      key: {l: 'DEL', v: '', act: 'del'},
    });
  });

  it('ignores unknown keys rather than moving', () => {
    const pos = {row: 1, col: 1};
    expect(navKeyboard(ROWS, pos, 'menu')).toEqual({kind: 'move', pos});
  });
});

describe('scrollTopFor', () => {
  const VISIBLE = 8;

  it('does not scroll while the row is already visible', () => {
    expect(scrollTopFor(0, 0, VISIBLE)).toBe(0);
    expect(scrollTopFor(7, 0, VISIBLE)).toBe(0);
    expect(scrollTopFor(10, 5, VISIBLE)).toBe(5);
  });

  it('scrolls down by exactly enough to reveal the row', () => {
    expect(scrollTopFor(8, 0, VISIBLE)).toBe(1);
    expect(scrollTopFor(9, 0, VISIBLE)).toBe(2);
  });

  it('scrolls up to put the row at the top', () => {
    expect(scrollTopFor(4, 10, VISIBLE)).toBe(4);
  });

  it('handles a jump far outside the window in either direction', () => {
    expect(scrollTopFor(100, 0, VISIBLE)).toBe(93);
    expect(scrollTopFor(0, 90, VISIBLE)).toBe(0);
  });

  it('is stable when re-applied to its own result', () => {
    // Stepping twice with no cursor move must not drift the viewport.
    const once = scrollTopFor(20, 0, VISIBLE);
    expect(scrollTopFor(20, once, VISIBLE)).toBe(once);
  });
});

// --- tab bar ---------------------------------------------------------------
// SHOW_PRESETS / SHOW_INPUTS (config/display.ts) decide whether the two WiiM
// device tabs appear at all. The list must stay CONTIGUOUS: the D-pad walks it
// by index, so a hidden entry left in place would read as a dead stop in the
// bar rather than as an absent tab.

describe('visibleTabs', () => {
  // Search is not a tab: it lives as a bar on the Browse screen itself.
  const LIBRARY = ['artists', 'albums', 'recent', 'playlists', 'collections'];

  it('keeps the five library tabs at every setting', () => {
    for (const p of [false, true]) {
      for (const i of [false, true]) {
        expect(visibleTabs(p, i)).toEqual(expect.arrayContaining(LIBRARY));
      }
    }
  });

  it('drops both device tabs when both are off (this install)', () => {
    expect(visibleTabs(false, false)).toEqual(LIBRARY);
  });

  it('shows each device tab only when its own flag is on', () => {
    expect(visibleTabs(true, false)).toEqual([...LIBRARY, 'presets']);
    expect(visibleTabs(false, true)).toEqual([...LIBRARY, 'inputs']);
    expect(visibleTabs(true, true)).toEqual([...LIBRARY, 'presets', 'inputs']);
  });

  it('preserves bar order and never leaves a gap', () => {
    for (const p of [false, true]) {
      for (const i of [false, true]) {
        const tabs = visibleTabs(p, i);
        // Every visible tab is a real tab, in ALL_TABS order, no duplicates.
        expect(new Set(tabs).size).toBe(tabs.length);
        const positions = tabs.map(t => ALL_TABS.indexOf(t));
        expect(positions).not.toContain(-1);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      }
    }
  });

  it('TABS reflects the shipped config — presets and inputs are off', () => {
    expect(TABS).toEqual(LIBRARY);
    expect(TABS).not.toContain('presets');
    expect(TABS).not.toContain('inputs');
  });
});
