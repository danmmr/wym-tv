import {fold, FOLD} from '../src/screens/searchText';

// The point of folding is that a query typed on a keyboard which offers only
// A-Z, 0-9 and space can still reach titles that are not spelled that way.
describe('fold', () => {
  it('lower cases', () => {
    expect(fold('Motörhead')).toBe('motorhead');
    expect(fold('SIGUR RÓS')).toBe('sigur ros');
  });

  it('folds accented Latin to its ASCII base', () => {
    expect(fold('Björk')).toBe('bjork');
    expect(fold('Bécs')).toBe('becs');
    expect(fold('Ólafur Arnalds')).toBe('olafur arnalds');
    expect(fold('Zdzisław')).toBe('zdzislaw');
  });

  it('folds the letters NFD would leave alone', () => {
    // These are single code points, not base + combining mark, so a
    // normalize/strip approach returns them unchanged.
    expect(fold('Ø')).toBe('o');
    expect(fold('Łódź')).toBe('lodz');
    expect(fold('Đ')).toBe('d');
  });

  it('expands the ligatures and sharp s rather than dropping them', () => {
    expect(fold('Æther')).toBe('aether');
    expect(fold('Œuvre')).toBe('oeuvre');
    expect(fold('Straße')).toBe('strasse');
  });

  it('leaves digits, spaces and punctuation alone', () => {
    expect(fold('17 Years In Ektachrome')).toBe('17 years in ektachrome');
    expect(fold(':zoviet*france:')).toBe(':zoviet*france:');
    expect(fold('The Day 1982 Contaminated')).toBe('the day 1982 contaminated');
  });

  it('is idempotent — folding folded text changes nothing', () => {
    const once = fold('Björk & Sigur Rós — Æ');
    expect(fold(once)).toBe(once);
  });

  it('makes an ASCII query a substring of the folded title', () => {
    // The actual use: indexOf over the folded index with a folded query.
    expect(fold('Björk — Homogenic').indexOf(fold('bjork'))).toBeGreaterThan(
      -1,
    );
    expect(fold('Fennesz — Bécs').indexOf(fold('becs'))).toBeGreaterThan(-1);
  });

  // The regression this suite previously could NOT catch.
  //
  // Hermes is built without Intl, so on the TV toLowerCase only maps A-Z:
  // 'Ólafur'.toLowerCase() comes back unchanged. Node maps the full range, so
  // any test that folds an upper-case accented string passes here whether or
  // not the table can handle it. Asserting on the TABLE instead of on fold()
  // is what makes this test able to fail.
  describe('the table covers both cases', () => {
    it('has an upper-case entry for every lower-case letter', () => {
      const missing: string[] = [];
      for (const ch of Object.keys(FOLD)) {
        const up = ch.toUpperCase();
        // An upper-case form that is already ASCII (ı -> I) needs no entry:
        // toLowerCase maps A-Z correctly on every engine.
        if (
          up.length === 1 &&
          up !== ch &&
          up.charCodeAt(0) > 127 &&
          FOLD[up] === undefined
        ) {
          missing.push(`${ch} -> ${up}`);
        }
      }
      expect(missing).toEqual([]);
    });

    it('folds an upper-case letter to the same ASCII as its lower-case form', () => {
      for (const ch of Object.keys(FOLD)) {
        const up = ch.toUpperCase();
        if (up.length === 1 && FOLD[up] !== undefined) {
          expect(FOLD[up]).toBe(FOLD[ch]);
        }
      }
    });
  });

  // Real entries from the library this runs against — the 46 albums whose
  // title or artist carries an upper-case accented letter.
  it('reaches the albums that actually failed on the TV', () => {
    expect(fold('Éliane Radigue')).toBe('eliane radigue');
    expect(fold('Ólafur Arnalds')).toBe('olafur arnalds');
    expect(fold('Åyusp')).toBe('ayusp');
    expect(fold('ChÖgyal Namkhai Norbu')).toBe('chogyal namkhai norbu');
    expect(fold('Anna Sigríður Þorvaldsdóttir')).toBe(
      'anna sigridur thorvaldsdottir',
    );
    // A one-character artist name that is nothing but an accented letter.
    expect(fold('Ø')).toBe('o');
    expect(fold('ØXN')).toBe('oxn');
  });

  it('handles an empty string', () => {
    expect(fold('')).toBe('');
  });
});
