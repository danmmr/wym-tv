// Text folding for Browse's search.
//
// The on-screen keyboard can only produce A-Z, 0-9 and a space. The library
// cannot: it holds Björk, Fennesz's Bécs, Sigur Rós, Motörhead, Ólafur
// Arnalds, Coil's Ø, Zdzisław Łódź. Matching the raw strings means those
// titles are reachable only by a substring that happens to dodge the accented
// letter — and for a title like Ø, by nothing at all.
//
// So both sides of the compare are folded to plain ASCII lower case first.
//
// The table holds BOTH cases of every letter, which is not redundancy.
// Hermes is built without Intl, so its case conversion is ASCII-ONLY: on the
// TV `'Ólafur'.toLowerCase()` returns `'Ólafur'`, not `'ólafur'`. A table keyed
// only in lower case therefore matched under Jest (Node, full Unicode) and
// missed on the device — 46 albums in this library carry an upper-case
// accented letter, Éliane Radigue's seventeen among them. Folding must not
// depend on toLowerCase reaching anything outside ASCII.
//
// This is also a TABLE rather than `String.prototype.normalize('NFD')` plus a
// combining-mark strip, for two reasons. Hermes ships normalize only when
// built with Intl, so relying on it means the behaviour differs between the
// Jest run (Node, always has it) and the TV — the exact split that makes a
// green test suite meaningless. And NFD does not help for the letters that
// are not a base plus a mark: ø, ł, đ, æ, ß and þ decompose to themselves.
// A table covers both cases and behaves identically everywhere.
export const FOLD: Record<string, string> = {
  À: 'a',
  Á: 'a',
  Â: 'a',
  Ã: 'a',
  Ä: 'a',
  Å: 'a',
  à: 'a',
  á: 'a',
  â: 'a',
  ã: 'a',
  ä: 'a',
  å: 'a',
  Ā: 'a',
  ā: 'a',
  Ă: 'a',
  ă: 'a',
  Ą: 'a',
  ą: 'a',
  Æ: 'ae',
  æ: 'ae',
  Ç: 'c',
  ç: 'c',
  Ć: 'c',
  ć: 'c',
  Ĉ: 'c',
  ĉ: 'c',
  Ċ: 'c',
  ċ: 'c',
  Č: 'c',
  č: 'c',
  Ð: 'd',
  ð: 'd',
  Ď: 'd',
  ď: 'd',
  Đ: 'd',
  đ: 'd',
  È: 'e',
  É: 'e',
  Ê: 'e',
  Ë: 'e',
  è: 'e',
  é: 'e',
  ê: 'e',
  ë: 'e',
  Ē: 'e',
  ē: 'e',
  Ĕ: 'e',
  ĕ: 'e',
  Ė: 'e',
  ė: 'e',
  Ę: 'e',
  ę: 'e',
  Ě: 'e',
  ě: 'e',
  Ĝ: 'g',
  ĝ: 'g',
  Ğ: 'g',
  ğ: 'g',
  Ġ: 'g',
  ġ: 'g',
  Ģ: 'g',
  ģ: 'g',
  Ĥ: 'h',
  ĥ: 'h',
  Ħ: 'h',
  ħ: 'h',
  Ì: 'i',
  Í: 'i',
  Î: 'i',
  Ï: 'i',
  ì: 'i',
  í: 'i',
  î: 'i',
  ï: 'i',
  Ĩ: 'i',
  ĩ: 'i',
  Ī: 'i',
  ī: 'i',
  Ĭ: 'i',
  ĭ: 'i',
  Į: 'i',
  į: 'i',
  İ: 'i',
  ı: 'i',
  Ĵ: 'j',
  ĵ: 'j',
  Ķ: 'k',
  ķ: 'k',
  Ĺ: 'l',
  ĺ: 'l',
  Ļ: 'l',
  ļ: 'l',
  Ľ: 'l',
  ľ: 'l',
  Ł: 'l',
  ł: 'l',
  Ñ: 'n',
  ñ: 'n',
  Ń: 'n',
  ń: 'n',
  Ņ: 'n',
  ņ: 'n',
  Ň: 'n',
  ň: 'n',
  Ò: 'o',
  Ó: 'o',
  Ô: 'o',
  Õ: 'o',
  Ö: 'o',
  Ø: 'o',
  ò: 'o',
  ó: 'o',
  ô: 'o',
  õ: 'o',
  ö: 'o',
  ø: 'o',
  Ō: 'o',
  ō: 'o',
  Ŏ: 'o',
  ŏ: 'o',
  Ő: 'o',
  ő: 'o',
  Œ: 'oe',
  œ: 'oe',
  Ŕ: 'r',
  ŕ: 'r',
  Ŗ: 'r',
  ŗ: 'r',
  Ř: 'r',
  ř: 'r',
  Ś: 's',
  ś: 's',
  Ŝ: 's',
  ŝ: 's',
  Ş: 's',
  ş: 's',
  Š: 's',
  š: 's',
  Ș: 's',
  ș: 's',
  ß: 'ss',
  ẞ: 'ss',
  Ţ: 't',
  ţ: 't',
  Ť: 't',
  ť: 't',
  Ŧ: 't',
  ŧ: 't',
  Ț: 't',
  ț: 't',
  Þ: 'th',
  þ: 'th',
  Ù: 'u',
  Ú: 'u',
  Û: 'u',
  Ü: 'u',
  ù: 'u',
  ú: 'u',
  û: 'u',
  ü: 'u',
  Ũ: 'u',
  ũ: 'u',
  Ū: 'u',
  ū: 'u',
  Ŭ: 'u',
  ŭ: 'u',
  Ů: 'u',
  ů: 'u',
  Ű: 'u',
  ű: 'u',
  Ų: 'u',
  ų: 'u',
  Ŵ: 'w',
  ŵ: 'w',
  Ý: 'y',
  ý: 'y',
  ÿ: 'y',
  Ŷ: 'y',
  ŷ: 'y',
  Ÿ: 'y',
  Ź: 'z',
  ź: 'z',
  Ż: 'z',
  ż: 'z',
  Ž: 'z',
  ž: 'z',
};

// toLowerCase handles A-Z, which it does correctly everywhere; the table
// handles the rest in whichever case it arrives. Characters with no entry pass
// through untouched, so punctuation, digits and CJK are left exactly as they
// are — this narrows the alphabet, it does not strip the string.
//
// Note a folded character can widen the string (ß -> ss), which is why this
// builds a new string rather than mapping in place.
export function fold(s: string): string {
  const lower = s.toLowerCase();
  let out = '';
  for (const ch of lower) {
    out += FOLD[ch] !== undefined ? FOLD[ch] : ch;
  }
  return out;
}

// A stack of previous result sets, so that BOTH typing and deleting reuse work
// instead of rescanning the whole catalog.
//
// Matching is a plain substring test, so the result sets for a query and any
// prefix of it nest: everything matching "brian e" also matched "brian", which
// also matched "bria". Each remembered entry is therefore a superset of every
// entry above it, and the stack is a chain of prefixes by construction.
//
// Typing pushes: narrow the top entry by the one new character.
// Deleting pops: the shorter query is already ON the stack, with the exact set
// it matched, so a backspace answers from memory and scans nothing at all.
// Only a query that is not a prefix of the top entry — the first character, or
// a jump the keyboard cannot actually produce — falls back to a full scan.
//
// Entry sizes fall off fast (one character usually cuts the set by an order of
// magnitude) and the depth is bounded by the query length, so the stack costs
// far less than the single 5.7k-string scan it replaces.
export type NarrowEntry = {q: string; idx: number[]};

export class SearchNarrower {
  // The haystack these positions refer to. Held by identity so a catalog
  // reload cannot be answered from positions that indexed the previous one.
  private src: string[] | null = null;
  private stack: NarrowEntry[] = [];

  // Positions in `index` whose string contains `q`. `q` is expected folded.
  // An empty query clears the stack and returns nothing — callers show the
  // whole catalog in that case rather than an empty result.
  match(index: string[], q: string): number[] {
    if (this.src !== index) {
      this.src = index;
      this.stack = [];
    }
    if (!q) {
      this.stack = [];
      return [];
    }

    // Drop every entry the new query does not extend. After this the top is
    // the longest remembered prefix of `q`, or the stack is empty.
    while (
      this.stack.length &&
      !q.startsWith(this.stack[this.stack.length - 1].q)
    ) {
      this.stack.pop();
    }
    const top = this.stack.length ? this.stack[this.stack.length - 1] : null;

    // Backspace, or a repeat: the answer is already here.
    if (top && top.q === q) {
      return top.idx;
    }

    const from = top ? top.idx : null;
    const idx: number[] = [];
    if (from) {
      for (let n = 0; n < from.length; n++) {
        const i = from[n];
        if (index[i].indexOf(q) !== -1) {
          idx.push(i);
        }
      }
    } else {
      for (let i = 0; i < index.length; i++) {
        if (index[i].indexOf(q) !== -1) {
          idx.push(i);
        }
      }
    }
    this.stack.push({q, idx});
    return idx;
  }

  // How many result sets are remembered. Exposed so a test can prove that a
  // backspace really popped rather than quietly rescanning to the same answer.
  get depth(): number {
    return this.stack.length;
  }
}
