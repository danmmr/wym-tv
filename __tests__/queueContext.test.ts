import {
  buildDidl,
  buildQueueContext,
  decodeEntities,
  htmlEsc,
  xText,
} from '../src/api/wiim';
import type {QueueTrack} from '../src/api/wiim';

// The WiiM PlayQueue format is entity-encoded at three levels: fields inside the
// DIDL, the DIDL as a text node inside QueueContext, and QueueContext itself as
// the SOAP argument. Getting a level wrong yields either a rejected queue or one
// that plays with mangled metadata — both only visible on a device across the
// room. These tests pin the escaping so a refactor can't quietly break playback.

const track = (over: Partial<QueueTrack> = {}): QueueTrack => ({
  url: 'http://plex.lan:32400/library/parts/1/file.flac?X-Plex-Token=abc',
  trackId: '/library/metadata/33263',
  albumId: '/library/metadata/33262/children',
  title: 'Earl Grey and Honey',
  artist: 'Damp Howl',
  album: 'Damp Howl Volume 1',
  durationMs: '809811',
  bitrate: '806',
  artUrl: 'http://plex.lan:32400/photo/:/transcode?width=1000&url=%2Fx',
  ...over,
});

describe('xText / htmlEsc', () => {
  it('escapes the five XML-significant characters at the right levels', () => {
    expect(xText('a&b<c>d"e')).toBe('a&amp;b&lt;c&gt;d&quot;e');
    // xText deliberately leaves apostrophes alone; htmlEsc escapes them too.
    expect(xText("Don't")).toBe("Don't");
    expect(htmlEsc("Don't")).toBe('Don&#x27;t');
  });

  it('escapes ampersands first so entities are not double-escaped', () => {
    expect(xText('&lt;')).toBe('&amp;lt;');
  });

  it('round-trips through decodeEntities', () => {
    const raw = 'Rock & Roll <"quoted"> \'apostrophe\'';
    expect(decodeEntities(htmlEsc(raw))).toBe(raw);
  });

  it('decodeEntities resolves ampersand last, so &amp;lt; is literal', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('buildDidl', () => {
  it('carries the track fields, escaped once', () => {
    const didl = buildDidl(track({title: 'Fire & Ice', artist: 'A<B'}));
    expect(didl).toContain('<dc:title>Fire &amp; Ice</dc:title>');
    expect(didl).toContain('<upnp:artist>A&lt;B</upnp:artist>');
    expect(didl).toContain('<song:id>/library/metadata/33263</song:id>');
    expect(didl).toContain('duration="809811"');
    expect(didl).toContain('<song:bitrate>806</song:bitrate>');
  });
});

describe('buildQueueContext', () => {
  it('names the list and counts the tracks', () => {
    const ctx = buildQueueContext('WiiMTV', [track(), track()]);
    expect(ctx).toContain('<ListName>WiiMTV</ListName>');
    expect(ctx).toContain('<TrackNumber>2</TrackNumber>');
    expect(ctx).toContain('<TotalNumber>2</TotalNumber>');
    expect(ctx).toContain('<SourceName>Plex</SourceName>');
  });

  it('numbers tracks from 1, not 0 (the device index is 1-based)', () => {
    const ctx = buildQueueContext('WiiMTV', [track(), track(), track()]);
    expect(ctx).toContain('<Track1>');
    expect(ctx).toContain('<Track3>');
    expect(ctx).not.toContain('<Track0>');
    expect(ctx).not.toContain('<Track4>');
  });

  it('encodes the DIDL one extra level as a text node', () => {
    const ctx = buildQueueContext('WiiMTV', [track()]);
    // The inner DIDL must appear escaped, never as live markup.
    expect(ctx).toContain('&lt;DIDL-Lite');
    expect(ctx).not.toContain('<DIDL-Lite');
    // The DIDL's own structural quotes are escaped once at this level.
    expect(ctx).toContain('&lt;?xml version=&quot;1.0&quot;?&gt;');
  });

  it('escapes an ampersand inside the DIDL twice (the 3-level case)', () => {
    // The art URL is a Plex transcode URL, so it always carries query
    // parameters. Its & is escaped once building the DIDL (&amp;) and again
    // when the DIDL becomes a text node (&amp;amp;). This is the level that
    // has historically been easiest to get wrong.
    const ctx = buildQueueContext('WiiMTV', [track()]);
    expect(ctx).toContain('&amp;amp;url=%2Fx');
  });

  it('escapes an ampersand in the stream URL exactly once', () => {
    // The URL sits directly in the QueueContext, one level shallower than the
    // DIDL, so it gets a single escape.
    const ctx = buildQueueContext('WiiMTV', [
      track({url: 'http://plex.lan/f.flac?a=1&b=2'}),
    ]);
    expect(ctx).toContain('<URL>http://plex.lan/f.flac?a=1&amp;b=2</URL>');
  });

  it('handles an empty queue without emitting a Track element', () => {
    const ctx = buildQueueContext('WiiMTV', []);
    expect(ctx).toContain('<TrackNumber>0</TrackNumber>');
    expect(ctx).toContain('<Tracks></Tracks>');
  });

  it('escapes a list name containing markup characters', () => {
    expect(buildQueueContext('A & B', [])).toContain(
      '<ListName>A &amp; B</ListName>',
    );
  });
});
