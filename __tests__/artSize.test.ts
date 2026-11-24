import {sizedArt} from '../src/api/artSize';

const PLEX =
  'http://192.0.2.1:32400/photo/:/transcode?width=1000&height=1000' +
  '&url=%2Flibrary%2Fmetadata%2F88667%2Fthumb%2F1787857873&format=jpeg';

describe('sizedArt', () => {
  it('shrinks both dimensions and nothing else', () => {
    expect(sizedArt(PLEX, 250)).toBe(
      PLEX.replace('width=1000&height=1000', 'width=250&height=250'),
    );
  });

  it('never enlarges', () => {
    expect(sizedArt(PLEX, 2000)).toBe(PLEX);
  });

  it('leaves other art alone', () => {
    const other = 'https://coverartarchive.org/release/x/front?width=1000';
    expect(sizedArt(other, 250)).toBe(other);
  });
});
