// The companion to plexUrls.test.ts, which covers the WITH-token shape. The
// token is optional (this server allows unauthenticated LAN access), so the
// no-token URLs are the ones actually shipping and need their own coverage.
jest.mock('../src/config/plex', () => ({
  PLEX: {
    baseUrl: 'http://plex.test:32400',
    // No token key at all — the shipped config comments the line out.
    musicSection: 4,
  },
}));

import {artUrl, streamUrl} from '../src/api/plex';

describe('streamUrl without a token', () => {
  it('emits a bare URL with no query string', () => {
    // A dangling "?" would be sent verbatim to Plex and to the WiiM, which
    // fetches these stream URLs itself.
    expect(streamUrl('/library/parts/36644/1745202128/file.flac')).toBe(
      'http://plex.test:32400/library/parts/36644/1745202128/file.flac',
    );
  });

  it('never mentions the token parameter', () => {
    expect(streamUrl('/library/parts/1/2/f.flac')).not.toContain('X-Plex-Token');
  });
});

describe('artUrl without a token', () => {
  it('keeps its own query string intact and adds no token', () => {
    const u = artUrl('/library/metadata/33262/thumb/1773562212', 320);
    expect(u).toContain('http://plex.test:32400/photo/:/transcode?');
    expect(u).toContain('width=320');
    expect(u).toContain('format=jpeg');
    expect(u).not.toContain('X-Plex-Token');
  });

  it('does not leave a trailing separator', () => {
    const u = artUrl('/library/metadata/1/thumb/2');
    expect(u.endsWith('&')).toBe(false);
    expect(u.endsWith('?')).toBe(false);
  });

  it('still returns empty string for a missing thumb', () => {
    expect(artUrl('')).toBe('');
  });
});
