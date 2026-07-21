// The real config is gitignored (it holds an account token), so a fresh clone
// has no src/config/plex.ts to import. Mocking it keeps this suite runnable
// anywhere and keeps a real token out of assertions and failure output.
jest.mock('../src/config/plex', () => ({
  PLEX: {
    baseUrl: 'http://plex.test:32400',
    token: 'TESTTOKEN',
    musicSection: 4,
  },
}));

import {artUrl, streamUrl} from '../src/api/plex';

describe('streamUrl', () => {
  it('prefixes the server and appends the token', () => {
    expect(streamUrl('/library/parts/36644/1745202128/file.flac')).toBe(
      'http://plex.test:32400/library/parts/36644/1745202128/file.flac' +
        '?X-Plex-Token=TESTTOKEN',
    );
  });
});

describe('artUrl', () => {
  it('returns empty string for a missing thumb', () => {
    // Callers rely on this to decide whether to render art at all.
    expect(artUrl('')).toBe('');
  });

  it('builds a square transcode URL at the requested size', () => {
    const u = artUrl('/library/metadata/33262/thumb/1773562212', 320);
    expect(u).toContain('http://plex.test:32400/photo/:/transcode?');
    expect(u).toContain('width=320');
    expect(u).toContain('height=320');
    expect(u).toContain('X-Plex-Token=TESTTOKEN');
  });

  it('url-encodes the thumb path so it survives as a query parameter', () => {
    const u = artUrl('/library/metadata/1/thumb/2');
    expect(u).toContain('url=%2Flibrary%2Fmetadata%2F1%2Fthumb%2F2');
    // The raw path must NOT appear unencoded — that would truncate the query.
    expect(u).not.toContain('url=/library');
  });

  it('defaults to full size when no size is given', () => {
    expect(artUrl('/x')).toContain('width=1000');
  });
});
