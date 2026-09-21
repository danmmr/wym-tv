// The "why this?" line under the album title on Now Playing: the album's year
// and label off the per-track request, plus a per-artist album count from one
// cached Container-Size=0 query. What's worth pinning: the count query's shape
// (artist.id, not /children — see the note on getArtistAlbumCount), that it is
// asked ONCE per artist per session, that the album's styles come off the
// ALBUM item (a track carries Genre but not Style) once per album, and that
// the rows drop missing parts rather than rendering "  ·  " around nothing.

jest.mock('../src/config/plex', () => ({
  PLEX: {baseUrl: 'http://plex.test:32400', token: '', musicSection: 4},
}));

jest.mock('axios', () => ({get: jest.fn()}));

import axios from 'axios';
import {
  getTrackInfo,
  getArtistAlbumCount,
  getAlbumStyles,
} from '../src/api/plex';
import {whyThisLines, STYLES_SHOWN} from '../src/screens/whyThis';

const mockGet = axios.get as jest.Mock;

// A track as Plex returns it, with the fields the line reads (shaped from a
// real response: parentYear is a NUMBER, parentStudio the label).
const TRACK = {
  ratingKey: '64805',
  title: 'Murder',
  grandparentTitle: 'New Order',
  grandparentRatingKey: '7344',
  parentRatingKey: '64785',
  parentTitle: 'Substance 1987',
  parentThumb: '/library/metadata/64785/thumb/1',
  parentStudio: 'Factory',
  parentYear: 1987,
  Media: [{audioCodec: 'flac'}],
};

beforeEach(() => {
  mockGet.mockReset();
});

describe('getTrackInfo — context fields', () => {
  it('maps year, label and the artist key', async () => {
    mockGet.mockResolvedValueOnce({
      data: {MediaContainer: {Metadata: [TRACK]}},
    });
    const info = await getTrackInfo('64805');
    expect(info.year).toBe('1987');
    expect(info.label).toBe('Factory');
    expect(info.artistKey).toBe('7344');
  });

  it("is '' for each field Plex leaves out", async () => {
    const bare: any = {...TRACK};
    delete bare.parentStudio;
    delete bare.parentYear;
    delete bare.grandparentRatingKey;
    mockGet.mockResolvedValueOnce({data: {MediaContainer: {Metadata: [bare]}}});
    const info = await getTrackInfo('64805');
    expect(info.year).toBe('');
    expect(info.label).toBe('');
    expect(info.artistKey).toBe('');
  });
});

describe('getArtistAlbumCount', () => {
  it('asks for a zero-row page filtered by artist.id and reads totalSize', async () => {
    mockGet.mockResolvedValueOnce({
      data: {MediaContainer: {size: 0, totalSize: 4}},
    });
    expect(await getArtistAlbumCount('7344')).toBe(4);
    const url: string = mockGet.mock.calls[0][0];
    expect(url).toContain('/library/sections/4/all?');
    expect(url).toContain('type=9');
    expect(url).toContain('artist.id=7344');
    expect(url).toContain('X-Plex-Container-Size=0');
    expect(url).not.toContain('/children');
  });

  it('asks once per artist per session', async () => {
    mockGet.mockResolvedValueOnce({
      data: {MediaContainer: {size: 0, totalSize: 12}},
    });
    expect(await getArtistAlbumCount('999')).toBe(12);
    expect(await getArtistAlbumCount('999')).toBe(12);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('makes no request for an empty key', async () => {
    expect(await getArtistAlbumCount('')).toBe(0);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('propagates a failed request so the caller can leave the count off', async () => {
    mockGet.mockRejectedValueOnce(new Error('unreachable'));
    await expect(getArtistAlbumCount('500')).rejects.toThrow('unreachable');
    // and does NOT remember the failure as a count
    mockGet.mockResolvedValueOnce({
      data: {MediaContainer: {size: 0, totalSize: 2}},
    });
    expect(await getArtistAlbumCount('500')).toBe(2);
  });
});

describe('getAlbumStyles', () => {
  // The album as Plex returns it: Style is a tag list, in Plex's order.
  const ALBUM = {
    ratingKey: '64785',
    title: 'Substance 1987',
    Style: [
      {id: 37066, tag: 'Alternative Dance'},
      {id: 35722, tag: 'Post-Punk'},
      {id: 37068, tag: 'Synth Pop'},
    ],
  };

  it('reads the tags off the album item, in order', async () => {
    mockGet.mockResolvedValueOnce({
      data: {MediaContainer: {Metadata: [ALBUM]}},
    });
    expect(await getAlbumStyles('64785')).toEqual([
      'Alternative Dance',
      'Post-Punk',
      'Synth Pop',
    ]);
    const url: string = mockGet.mock.calls[0][0];
    expect(url).toContain('/library/metadata/64785');
  });

  it('asks once per album per session', async () => {
    mockGet.mockResolvedValueOnce({
      data: {MediaContainer: {Metadata: [{...ALBUM, ratingKey: '1'}]}},
    });
    expect(await getAlbumStyles('1')).toHaveLength(3);
    expect(await getAlbumStyles('1')).toHaveLength(3);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('is [] for an album with no styles, and for an empty key', async () => {
    const bare: any = {...ALBUM, ratingKey: '2'};
    delete bare.Style;
    mockGet.mockResolvedValueOnce({data: {MediaContainer: {Metadata: [bare]}}});
    expect(await getAlbumStyles('2')).toEqual([]);
    expect(await getAlbumStyles('')).toEqual([]);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed request rather than remembering [] for it', async () => {
    mockGet.mockRejectedValueOnce(new Error('unreachable'));
    await expect(getAlbumStyles('3')).rejects.toThrow('unreachable');
    mockGet.mockResolvedValueOnce({
      data: {MediaContainer: {Metadata: [{...ALBUM, ratingKey: '3'}]}},
    });
    expect(await getAlbumStyles('3')).toHaveLength(3);
  });
});

describe('whyThisLines', () => {
  it('is three rows: year · label, styles, album count', () => {
    expect(
      whyThisLines({
        year: '1987',
        label: 'Factory',
        artistAlbums: 4,
        styles: ['Post-Punk', 'Synth Pop'],
      }),
    ).toEqual([
      '1987  ·  Factory',
      'Post-Punk, Synth Pop',
      '4 albums in library',
    ]);
  });

  it(`shows at most ${STYLES_SHOWN} styles, in Plex's order`, () => {
    expect(STYLES_SHOWN).toBe(2);
    expect(
      whyThisLines({
        year: '',
        label: '',
        styles: ['Alternative Dance', 'Post-Punk', 'Synth Pop', 'Dance-Rock'],
      }),
    ).toEqual(['Alternative Dance, Post-Punk']);
  });

  it('says "only album" for a count of one', () => {
    expect(whyThisLines({year: '2001', label: '', artistAlbums: 1})).toEqual([
      '2001',
      'only album in library',
    ]);
  });

  it('drops missing parts and empty rows without leaving separators', () => {
    expect(whyThisLines({year: '', label: 'Warp'})).toEqual(['Warp']);
    expect(whyThisLines({year: '1999', label: '', artistAlbums: 0})).toEqual([
      '1999',
    ]);
    expect(whyThisLines({year: '1999', label: '', styles: ['', ' ']})).toEqual([
      '1999',
    ]);
    expect(whyThisLines({year: '', label: '', artistAlbums: 3})).toEqual([
      '3 albums in library',
    ]);
  });

  it('is empty when there is nothing to say', () => {
    expect(whyThisLines(undefined)).toEqual([]);
    expect(whyThisLines({year: '', label: ''})).toEqual([]);
  });
});
