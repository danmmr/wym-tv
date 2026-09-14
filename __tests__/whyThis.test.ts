// The "why this?" line under the album title on Now Playing: the album's year
// and label off the per-track request, plus a per-artist album count from one
// cached Container-Size=0 query. What's worth pinning: the count query's shape
// (artist.id, not /children — see the note on getArtistAlbumCount), that it is
// asked ONCE per artist per session, and that the line drops missing parts
// rather than rendering "  ·  " around nothing.

jest.mock('../src/config/plex', () => ({
  PLEX: {baseUrl: 'http://plex.test:32400', token: '', musicSection: 4},
}));

jest.mock('axios', () => ({get: jest.fn()}));

import axios from 'axios';
import {getTrackInfo, getArtistAlbumCount} from '../src/api/plex';
import {whyThisLine} from '../src/screens/whyThis';

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

describe('whyThisLine', () => {
  it('joins year, label and count with a spaced middot', () => {
    expect(whyThisLine({year: '1987', label: 'Factory', artistAlbums: 4})).toBe(
      '1987  ·  Factory  ·  4 albums in library',
    );
  });

  it('says "only album" for a count of one', () => {
    expect(whyThisLine({year: '2001', label: '', artistAlbums: 1})).toBe(
      '2001  ·  only album in library',
    );
  });

  it('drops missing parts without leaving separators behind', () => {
    expect(whyThisLine({year: '', label: 'Warp'})).toBe('Warp');
    expect(whyThisLine({year: '1999', label: '', artistAlbums: 0})).toBe(
      '1999',
    );
  });

  it('is empty when there is nothing to say', () => {
    expect(whyThisLine(undefined)).toBe('');
    expect(whyThisLine({year: '', label: ''})).toBe('');
  });
});
