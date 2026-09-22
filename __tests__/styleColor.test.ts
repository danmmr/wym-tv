// Per-style tile colours. Derived from the name, never stored — so the only
// things that can go wrong are silent ones: a hue that drifts between launches,
// a negative number that React Native renders as transparent, or two adjacent
// styles landing on the same colour and defeating the point.

import {
  styleHash,
  styleHue,
  styleChip,
  styleGlyph,
} from '../src/screens/styleColor';

describe('styleHue', () => {
  it('is stable for the same name', () => {
    expect(styleHue('Drone')).toBe(styleHue('Drone'));
  });

  it('always lands inside the colour wheel', () => {
    // The trap this guards: JS bitwise ops are SIGNED, so an unclamped FNV
    // multiply goes negative and `% 360` follows it. A negative hue is not an
    // error in React Native — it is a colour that does not render.
    const names = [
      'Drone',
      'IDM',
      'Post Rock',
      'Éliane',
      '',
      'a'.repeat(200),
      'Ø',
      '高田みどり',
    ];
    for (const n of names) {
      const h = styleHue(n);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(styleHash(n)).toBeGreaterThanOrEqual(0);
    }
  });

  it('separates names that are anagrams of each other', () => {
    // Order has to matter. A hash that merely SUMS char codes ties every
    // anagram, and these are real style names rearranged — the cheap hash is
    // the one worth ruling out, because it passes every other test here.
    expect(styleHue('Free Jazz')).not.toBe(styleHue('Jazz Free'));
    expect(styleHue('Dub Techno')).not.toBe(styleHue('Techno Dub'));
    expect(styleHue('Post Rock')).not.toBe(styleHue('Rock Post'));
    expect(styleHue('Dark Ambient')).not.toBe(styleHue('Ambient Dark'));
  });

  it('separates names that sit next to each other in the grid', () => {
    expect(styleHue('Post Rock')).not.toBe(styleHue('Prog Rock'));
    expect(styleHue('Breakbeat')).not.toBe(styleHue('Breaks'));
    expect(styleHue('Dub')).not.toBe(styleHue('Dub Techno'));
    expect(styleHue('Contemporary')).not.toBe(styleHue('Contemporary Jazz'));
  });

  it('spreads a real style list across the wheel', () => {
    // Not a distribution proof — just that the hues are not all bunched, which
    // is what a weak hash over short similar strings would produce.
    const real = [
      'Abstract',
      'Acoustic',
      'Alternative Rock',
      'Ambient',
      'Art Rock',
      'Avant-Garde Jazz',
      'Avantgarde',
      'Berlin-School',
      'Black Metal',
      'Breakbeat',
      'Breaks',
      'Contemporary',
      'Contemporary Jazz',
      'Dark Ambient',
      'Doom Metal',
      'Downtempo',
      'Drone',
      'Drum n Bass',
      'Dub',
      'Dub Techno',
      'Electro',
      'Experimental',
      'Field Recording',
      'Folk',
      'Folk Rock',
      'Free Improvisation',
      'Free Jazz',
      'Glitch',
      'House',
      'IDM',
      'Illbient',
      'Indie Rock',
      'Industrial',
      'Krautrock',
    ];
    const hues = real.map(styleHue);
    expect(new Set(hues).size).toBeGreaterThan(real.length * 0.85);
    // Every 60-degree sextant should see something.
    const sextants = new Set(hues.map(h => Math.floor(h / 60)));
    expect(sextants.size).toBe(6);
  });
});

describe('styleChip / styleGlyph', () => {
  it('emits colours React Native can parse', () => {
    for (const focused of [true, false]) {
      expect(styleChip('Drone', focused)).toMatch(
        /^hsl\(\d{1,3}, \d{1,3}%, \d{1,3}%\)$/,
      );
    }
    expect(styleGlyph('Drone', true)).toBe('#ffffff');
    expect(styleGlyph('Drone', false)).toMatch(/^hsl\(/);
  });

  it('keeps a style on one hue across both states', () => {
    // The chip brightens on focus; it must not change colour, or focusing a
    // tile would look like moving to a different style.
    const hue = (c: string) => /^hsl\((\d+)/.exec(c)![1];
    expect(hue(styleChip('Krautrock', true))).toBe(
      hue(styleChip('Krautrock', false)),
    );
    expect(hue(styleGlyph('Krautrock', false))).toBe(
      hue(styleChip('Krautrock', false)),
    );
  });

  it('is brighter when focused', () => {
    const light = (c: string) => Number(/(\d+)%\)$/.exec(c)![1]);
    expect(light(styleChip('IDM', true))).toBeGreaterThan(
      light(styleChip('IDM', false)),
    );
  });
});
