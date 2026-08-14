// getTrackInfo resolves the album a track belongs to, which is what Now
// Playing's "Album" button plays. The album fields ride along on the request
// that already fetches the codec, so what's tested here is purely the mapping
// from a Plex track object onto PlexTrackInfo.

// See the note in plexUrls.test.ts: the real config is gitignored, so mock it.
jest.mock('../src/config/plex', () => ({
  PLEX: {
    baseUrl: 'http://plex.test:32400',
    token: 'TESTTOKEN',
    musicSection: 4,
  },
}));

jest.mock('axios', () => ({get: jest.fn()}));

import axios from 'axios';
import {getTrackInfo} from '../src/api/plex';

const mockGet = axios.get as jest.Mock;

// Reply as Plex does: a MediaContainer wrapping one track object.
function plexReplies(track: any | null) {
  mockGet.mockResolvedValueOnce({
    data: {MediaContainer: track ? {Metadata: [track]} : {}},
  });
}

// A track as Plex returns it for a normal, single-artist album.
const NORMAL_TRACK = {
  ratingKey: '5001',
  title: 'Roygbiv',
  grandparentTitle: 'Boards of Canada',
  parentRatingKey: '4200',
  parentTitle: 'Music Has the Right to Children',
  parentThumb: '/library/metadata/4200/thumb/1699',
  Media: [{audioCodec: 'flac'}],
};

beforeEach(() => {
  mockGet.mockReset();
});

describe('getTrackInfo — album resolution', () => {
  it('returns the parent album of a normal track', async () => {
    plexReplies(NORMAL_TRACK);
    const info = await getTrackInfo('/library/metadata/5001');
    expect(info.albumKey).toBe('4200');
    expect(info.albumTitle).toBe('Music Has the Right to Children');
    expect(info.albumArtist).toBe('Boards of Canada');
    expect(info.albumThumb).toBe('/library/metadata/4200/thumb/1699');
  });

  it('keeps albumThumb a RAW path, not a transcode URL', async () => {
    // buildAlbumQueue calls artUrl(album.thumb) itself; handing it an already
    // built URL would double-wrap it and the queue art would break.
    plexReplies(NORMAL_TRACK);
    const info = await getTrackInfo('/library/metadata/5001');
    expect(info.albumThumb.startsWith('/library/metadata/')).toBe(true);
    expect(info.albumThumb).not.toContain('/photo/:/transcode');
  });

  it('accepts a bare rating key as well as a full path', async () => {
    plexReplies(NORMAL_TRACK);
    await getTrackInfo('5001');
    expect(mockGet.mock.calls[0][0]).toContain('/library/metadata/5001');
  });

  it('labels a compilation album with the ALBUM artist, not the track credit', async () => {
    // The album as a whole is "Various Artists" even though this track's own
    // credit is "Slim Moon" — guards the 2026-08-08 compilation artist fix
    // from being applied at the wrong level.
    plexReplies({
      ...NORMAL_TRACK,
      grandparentTitle: 'Various Artists',
      originalTitle: 'Slim Moon',
      parentTitle: '20 Years Of Kill Rock Stars',
    });
    const info = await getTrackInfo('/library/metadata/5001');
    expect(info.albumArtist).toBe('Various Artists');
    expect(info.artist).toBe('Slim Moon'); // per-track credit, unchanged
  });

  it('returns empty album fields when the track has no parent album', async () => {
    plexReplies({title: 'Orphan', grandparentTitle: 'Someone'});
    const info = await getTrackInfo('/library/metadata/5001');
    expect(info.albumKey).toBe('');
    expect(info.albumTitle).toBe('');
    expect(info.albumArtist).toBe('');
    expect(info.albumThumb).toBe('');
  });

  it('returns empty album fields when Plex returns no track', async () => {
    plexReplies(null);
    const info = await getTrackInfo('/library/metadata/5001');
    expect(info.albumKey).toBe('');
    expect(info.codec).toBe('');
  });

  it('makes no request at all for an empty id', async () => {
    const info = await getTrackInfo('');
    expect(mockGet).not.toHaveBeenCalled();
    expect(info.albumKey).toBe('');
  });

  it('still returns the codec and per-track artist', async () => {
    // The album fields are additive — the original two must be untouched.
    plexReplies(NORMAL_TRACK);
    const info = await getTrackInfo('/library/metadata/5001');
    expect(info.codec).toBe('FLAC');
    expect(info.artist).toBe('Boards of Canada');
  });
});
