import {decodeHex} from '../src/api/hex';

// The WiiM returns Title/Artist/Album as hex-encoded UTF-8 that ALSO contains
// HTML entities. Both layers have bitten this app before (commit 9607ba1 added
// the entity pass), and the only place it shows up is as mangled text on a TV
// across the room — so pin the behaviour here.

const hexOf = (s: string): string =>
  Array.from(Buffer.from(s, 'utf8'))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

describe('decodeHex', () => {
  it('returns empty string for empty input', () => {
    expect(decodeHex('')).toBe('');
  });

  it('decodes plain ASCII', () => {
    expect(decodeHex(hexOf('Motion in Field'))).toBe('Motion in Field');
  });

  it('decodes 2-byte UTF-8 (accented Latin)', () => {
    expect(decodeHex(hexOf('Björk'))).toBe('Björk');
    expect(decodeHex(hexOf('Sigur Rós'))).toBe('Sigur Rós');
  });

  it('decodes 3-byte UTF-8 (CJK)', () => {
    expect(decodeHex(hexOf('坂本龍一'))).toBe('坂本龍一');
  });

  it('decodes 4-byte UTF-8 via surrogate pair (emoji)', () => {
    expect(decodeHex(hexOf('Drone 🎧'))).toBe('Drone 🎧');
  });

  it('decodes HTML entities left in the hex payload', () => {
    // This is the real-world case: the WiiM hex-encodes a string that itself
    // still contains &apos; rather than a literal apostrophe.
    expect(decodeHex(hexOf('Don&apos;t Look Back'))).toBe("Don't Look Back");
    expect(decodeHex(hexOf('Rock &amp; Roll'))).toBe('Rock & Roll');
    expect(decodeHex(hexOf('&quot;Live&quot;'))).toBe('"Live"');
    expect(decodeHex(hexOf('&lt;untitled&gt;'))).toBe('<untitled>');
  });

  it('decodes numeric character references, decimal and hex', () => {
    expect(decodeHex(hexOf('Caf&#233;'))).toBe('Café');
    expect(decodeHex(hexOf('Caf&#xe9;'))).toBe('Café');
  });

  it('does not double-decode an escaped ampersand', () => {
    // &amp;apos; must come back as the literal text "&apos;", not an apostrophe.
    expect(decodeHex(hexOf('&amp;apos;'))).toBe('&apos;');
  });

  it('ignores a trailing odd nibble rather than throwing', () => {
    expect(decodeHex(hexOf('OK') + 'f')).toBe('OK');
  });
});
