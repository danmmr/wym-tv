// Display preferences. Tracked in git (nothing secret here) — unlike
// hosts.data.json and plex.ts, this file is the same for every install and is
// meant to be edited in place.
//
// NOTE: do NOT add a `display.json` beside this module. Metro resolves
// sourceExts in the order js, jsx, json, ts, tsx — json BEFORE ts — so a
// same-named .json silently shadows the .ts in a release build while jest
// (which resolves ts first) keeps passing. That trap cost an evening once.

// Every setting here is one of these: 0 = off, 1 = on.
export type Toggle = 0 | 1;

/**
 * Ordering of the Browse screen's Albums grid and Artists roster.
 *
 *   1 = random  (default — a fresh, stable-for-the-session shuffle each launch)
 *   0 = no random  (alphabetical: albums by title, artists by name)
 *
 * This governs BROWSING only. "Feeling lucky?", the Library Radio / Deep Cuts
 * stations and the art-frame slideshow are random by definition and ignore it.
 *
 * Both listings are SAMPLES, capped at ALBUM_SAMPLE / ARTIST_SAMPLE (500 each,
 * in api/plex.ts) regardless of this setting: at 1 a random draw, at 0 the
 * first 500 alphabetically. The full catalog is ~4.5k albums and holding all of
 * it on screen is what the 1.7 GB stick cannot afford. The cap is display-only
 * — Search still covers the whole catalog.
 */
export const RANDOM_ORDER: Toggle = 1;

/**
 * Which optional tabs the Browse screen offers.
 *
 *   1 = shown
 *   0 = hidden  (the tab is absent from the tab bar entirely, not just empty,
 *                and the WiiM query that populates it is never made)
 *
 * Both are WiiM device features rather than library browsing: Presets are the
 * unit's own six stored stations, Inputs its physical/streaming sources. They
 * are off by default because this install does not use them.
 *
 * The tabs the library needs — Artists, Albums, Recent, Playlists, Search —
 * are not configurable; hiding one of those would strand part of the library.
 */
export const SHOW_PRESETS: Toggle = 0;
export const SHOW_INPUTS: Toggle = 0;

// Predicates, so call sites read as intent rather than as a number. Each takes
// its setting through `on()` rather than comparing the constant inline: TS
// narrows a `const` to its literal value, so an inline `SHOW_PRESETS === 1`
// would be a compile ERROR ("no overlap") the moment the default is 0.
const on = (v: Toggle): boolean => v === 1;

export const randomOrderEnabled = (): boolean => on(RANDOM_ORDER);
export const presetsEnabled = (): boolean => on(SHOW_PRESETS);
export const inputsEnabled = (): boolean => on(SHOW_INPUTS);
