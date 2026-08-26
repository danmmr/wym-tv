// Pure D-pad cursor maths for BrowseScreen.
//
// BrowseScreen manages its own focus cursor (the app captures the D-pad rather
// than using native TV focus, which draws no highlight on Fire OS). Two pieces
// of that were duplicated between the Artists tab and the Search tab, which
// share an on-screen keyboard and a results list: the keyboard cursor movement,
// and the "keep the focused row on screen" scroll stepping.
//
// They live here as pure functions so they can be unit tested — on-device the
// only way to check them is to drive the remote and look at a TV.

import {inputsEnabled, presetsEnabled} from '../config/display';

// --- tab bar ---------------------------------------------------------------

// Every tab BrowseScreen can render, in bar order. The two WiiM device tabs at
// the end are optional (SHOW_PRESETS / SHOW_INPUTS in config/display.ts); the
// five library tabs are always present.
//
// Search is deliberately NOT here. It stopped being a destination you travel
// to and became a bar that is always on the Browse screen itself, so it has no
// tile in the chooser and no index in this list.
export const ALL_TABS = [
  'artists',
  'albums',
  'recent',
  'playlists',
  'collections',
  'presets',
  'inputs',
];

// The tabs actually offered, in bar order. Filtering the list rather than
// hiding entries at render time is what keeps left/right tab navigation
// correct: the D-pad walks the array by index, so a hidden-but-present entry
// would read as a dead stop in the bar.
export function visibleTabs(
  showPresets: boolean,
  showInputs: boolean,
): string[] {
  return ALL_TABS.filter(t =>
    t === 'presets' ? showPresets : t === 'inputs' ? showInputs : true,
  );
}

// Resolved once from config, which is static for a build.
export const TABS = visibleTabs(presetsEnabled(), inputsEnabled());

// `n` marks a narrow key. The digit row is ten wide against the letter rows'
// seven, so its keys shrink to keep the whole block the same width.
export type KeyCell = {
  l: string;
  v: string;
  act?: 'space' | 'del' | 'clear';
  n?: boolean;
};

export type KeyPos = {row: number; col: number};

// What a keyboard cursor move resolves to. 'move' stays on the keyboard;
// everything else is an edge the caller decides how to handle, since Artists and
// Search exit the keyboard to different places.
export type KeyNav =
  | {kind: 'move'; pos: KeyPos}
  | {kind: 'press'; key: KeyCell}
  | {kind: 'exitLeft'}
  | {kind: 'exitRight'}
  | {kind: 'exitUp'}
  | {kind: 'exitDown'};

// Move the on-screen keyboard cursor. Rows are ragged (the letter rows are 7
// wide, the last row has 3 action keys), so a vertical move clamps the column
// into the destination row rather than landing out of bounds.
export function navKeyboard(rows: KeyCell[][], pos: KeyPos, k: string): KeyNav {
  const row = rows[pos.row];
  if (!row) {
    return {kind: 'exitUp'};
  }

  switch (k) {
    case 'left':
      return pos.col > 0
        ? {kind: 'move', pos: {row: pos.row, col: pos.col - 1}}
        : {kind: 'exitLeft'};
    case 'right':
      return pos.col < row.length - 1
        ? {kind: 'move', pos: {row: pos.row, col: pos.col + 1}}
        : {kind: 'exitRight'};
    case 'up': {
      if (pos.row === 0) {
        return {kind: 'exitUp'};
      }
      const nr = pos.row - 1;
      return {
        kind: 'move',
        pos: {row: nr, col: Math.min(pos.col, rows[nr].length - 1)},
      };
    }
    case 'down': {
      if (pos.row >= rows.length - 1) {
        return {kind: 'exitDown'};
      }
      const nr = pos.row + 1;
      return {
        kind: 'move',
        pos: {row: nr, col: Math.min(pos.col, rows[nr].length - 1)},
      };
    }
    case 'select':
      return {kind: 'press', key: row[pos.col]};
    default:
      return {kind: 'move', pos};
  }
}

// New scroll offset (in rows) needed to keep row `i` visible in a window of
// `visible` rows currently starting at `top`. Returns `top` unchanged when no
// scroll is needed — callers compare against the old value and only scroll on a
// change, which is what keeps browsing smooth instead of re-centering on every
// keypress.
export function scrollTopFor(i: number, top: number, visible: number): number {
  if (i < top) {
    return i;
  }
  if (i > top + visible - 1) {
    return i - visible + 1;
  }
  return top;
}
