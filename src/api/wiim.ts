import axios, {AxiosInstance} from 'axios';
import {decodeHex} from './hex';

export interface WiiMPlayerStatus {
  type: string;
  ch: string;
  mode: string;
  loop: string;
  eq: string;
  status: 'play' | 'pause' | 'stop';
  curpos: string;
  totlen: string;
  Title: string;
  Artist: string;
  Album: string;
  alarmflag: string;
  plicount: string;
  plicurr: string;
  vol: string;
  mute: string;
}

// WiiM/LinkPlay devices serve the HTTP API over HTTPS with a self-signed cert.
// The app's OkHttp client (see MainApplication.kt) is configured to trust it.
// A single track as handed to the WiiM's native play queue.
export interface QueueTrack {
  url: string; // streamable Plex part URL (incl. token)
  trackId: string; // Plex metadata path, e.g. /library/metadata/123
  albumId: string; // Plex album children path, e.g. /library/metadata/120/children
  title: string;
  artist: string;
  album: string;
  durationMs: string;
  bitrate: string;
  artUrl: string; // album cover (Plex transcode URL)
}

// One row of the device's current play queue, read back via BrowseQueue.
export interface QueueItem {
  index: number; // 1-based position in the queue
  title: string;
  artist: string;
}

export interface QueueInfo {
  listName: string; // the queue's ListName (needed to jump within it)
  items: QueueItem[];
}

// Fixed name for the queue we push. The album name still shows in Now Playing
// via each track's metadata; this is just the internal queue handle, so a
// constant keeps PlayQueueWithIndex reliable regardless of album title chars.
//
// DELIBERATELY still "WiiMTV" after the rename to WyM TV. This string does not
// belong to the app — it is the queue's ListName ON THE WiiM, and both station
// auto-refill (appendQueue) and the Queue screen's jump-to-track (playIndex)
// address the queue by it. Changing it would orphan whatever queue is playing
// when the new build lands: the device would still be playing "WiiMTV" while
// the app looked for the new name, and refill and jump-to-track would both
// silently stop working until the next album or station push recreated it.
// The user-visible label is queueDisplayName() below.
const QUEUE_NAME = 'WiiMTV';

// What to SHOW for a queue. Our own handle is an internal id, so display the
// app's name for it; queues pushed by other apps keep whatever they call
// themselves, which is the only clue about where they came from.
export const QUEUE_DISPLAY_NAME = 'WyM TV';

export function queueDisplayName(listName: string): string {
  return listName === QUEUE_NAME ? QUEUE_DISPLAY_NAME : listName;
}

// XML escaping helpers. The WiiM PlayQueue format is double-encoded: each
// track's DIDL-Lite <Metadata> is entity-encoded as a text node *inside* the
// QueueContext, and the whole QueueContext is entity-encoded again as the SOAP
// argument. xText handles XML text/attribute content; htmlEsc additionally
// escapes apostrophes and is used for the two wrapping layers. This mirrors the
// exact format the WiiM Home app produces (reverse-engineered via BrowseQueue).
// Exported for unit tests — this escaping is the single most breakage-prone
// thing in the app (a missed level silently yields a queue the WiiM rejects or
// plays with mangled metadata), and it is otherwise only observable on device.
export function xText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
export function htmlEsc(s: string): string {
  return xText(s).replace(/'/g, '&#x27;');
}

// Reverse of the escaping above, for parsing BrowseQueue responses (which are
// entity-encoded, and contain a second entity-encoded DIDL inside <Metadata>).
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) =>
      String.fromCharCode(parseInt(n, 16)),
    )
    .replace(/&amp;/g, '&'); // ampersand last so it doesn't double-decode
}

export function buildDidl(t: QueueTrack): string {
  return (
    '<?xml version="1.0"?>' +
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:song="www.linkplay.com/song/" ' +
    'xmlns:custom="www.linkplay.com/custom/" ' +
    'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class><item>' +
    `<song:id>${xText(t.trackId)}</song:id>` +
    `<song:albumid>${xText(t.albumId)}</song:albumid>` +
    `<dc:title>${xText(t.title)}</dc:title>` +
    `<upnp:artist>${xText(t.artist)}</upnp:artist>` +
    `<upnp:album>${xText(t.album)}</upnp:album>` +
    '<res protocolInfo="http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_OP=01;" ' +
    `duration="${t.durationMs}"></res>` +
    `<upnp:albumArtURI>${xText(t.artUrl)}</upnp:albumArtURI>` +
    '<song:rate_hz>44100</song:rate_hz><song:format_s>16</song:format_s>' +
    `<song:bitrate>${t.bitrate}</song:bitrate>` +
    '</item></DIDL-Lite>'
  );
}

export function buildQueueContext(name: string, tracks: QueueTrack[]): string {
  let trackXml = '';
  tracks.forEach((t, i) => {
    const idx = i + 1;
    const md = htmlEsc(buildDidl(t)); // DIDL encoded as a text node
    trackXml +=
      `<Track${idx}><URL>${xText(t.url)}</URL>` +
      `<Metadata>${md}</Metadata>` +
      `<Id>${xText(t.trackId)}</Id><Source>Plex</Source>` +
      `<ChapterNumber>0</ChapterNumber><Chapters></Chapters></Track${idx}>`;
  });
  return (
    '<?xml version="1.0"?><PlayList>' +
    `<ListName>${xText(name)}</ListName>` +
    '<ListInfo><SourceName>Plex</SourceName><MarkSearch>0</MarkSearch>' +
    `<TrackNumber>${tracks.length}</TrackNumber>` +
    `<TotalNumber>${tracks.length}</TotalNumber>` +
    '<Quality>0</Quality><LastPlayIndex>0</LastPlayIndex>' +
    '<ContentType>songlist</ContentType>' +
    '<CurrentPage>0</CurrentPage><TotalPages>0</TotalPages></ListInfo>' +
    `<Tracks>${trackXml}</Tracks></PlayList>`
  );
}

export class WiiMClient {
  private client: AxiosInstance;
  private baseURL: string;
  private ip: string;

  constructor(ip: string) {
    this.ip = ip;
    this.baseURL = `https://${ip}`;
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 5000,
    });
  }

  private async command(cmd: string): Promise<any> {
    const response = await this.client.get(`/httpapi.asp?command=${cmd}`);
    return response.data;
  }

  async getStatus(): Promise<WiiMPlayerStatus> {
    return this.command('getPlayerStatus');
  }

  async getDeviceInfo(): Promise<any> {
    return this.command('getStatusEx');
  }

  // Newer WiiM firmware returns rich metadata incl. albumArtURI for the
  // currently playing track (e.g. the Plex transcode URL for local libraries).
  async getMetaInfo(): Promise<any> {
    return this.command('getMetaInfo');
  }

  async pause(): Promise<void> {
    await this.command('setPlayerCmd:pause');
  }

  async resume(): Promise<void> {
    await this.command('setPlayerCmd:resume');
  }

  async stop(): Promise<void> {
    await this.command('setPlayerCmd:stop');
  }

  async next(): Promise<void> {
    await this.command('setPlayerCmd:next');
  }

  async prev(): Promise<void> {
    await this.command('setPlayerCmd:prev');
  }

  async setVolume(vol: number): Promise<void> {
    const clipped = Math.max(0, Math.min(100, vol));
    await this.command(`setPlayerCmd:vol:${clipped}`);
  }

  async setMute(mute: boolean): Promise<void> {
    await this.command(`setPlayerCmd:mute:${mute ? 1 : 0}`);
  }

  async seek(seconds: number): Promise<void> {
    await this.command(`setPlayerCmd:seek:${Math.floor(seconds)}`);
  }

  async getPresetInfo(): Promise<any> {
    return this.command('getPresetInfo');
  }

  async loadPreset(presetId: number): Promise<void> {
    await this.command(`setPlayerCmd:preset:${presetId}`);
  }

  async switchInput(input: string): Promise<void> {
    await this.command(`setPlayerCmd:switchmode:${input}`);
  }

  // --- native play queue (WiiMu PlayQueue UPnP service, port 49152) ---------
  // Pushes a whole album into the WiiM's own queue and plays it. Because the
  // queue lives in the device, it auto-advances with full metadata/art and
  // keeps playing even after this app exits — no embedded server needed.
  private async playQueueSoap(action: string, inner: string): Promise<string> {
    const body =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
      `<u:${action} xmlns:u="urn:schemas-wiimu-com:service:PlayQueue:1">` +
      `${inner}</u:${action}></s:Body></s:Envelope>`;
    const res = await axios.post(
      `http://${this.ip}:49152/upnp/control/PlayQueue1`,
      body,
      {
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPACTION: `"urn:schemas-wiimu-com:service:PlayQueue:1#${action}"`,
        },
        timeout: 10000,
      },
    );
    return typeof res.data === 'string' ? res.data : String(res.data);
  }

  // Read the device's current play queue. ListName is the queue handle needed
  // to jump within it via playIndex().
  async browseQueue(): Promise<QueueInfo> {
    const resp = await this.playQueueSoap(
      'BrowseQueue',
      '<QueueName>CurrentQueue</QueueName>',
    );
    const ctx = /<QueueContext>([\s\S]*?)<\/QueueContext>/.exec(resp);
    if (!ctx) {
      return {listName: '', items: []};
    }
    const playlist = decodeEntities(ctx[1]);
    const nameM = /<ListName>([\s\S]*?)<\/ListName>/.exec(playlist);
    const listName = nameM ? decodeEntities(nameM[1]).trim() : '';
    const items: QueueItem[] = [];
    const metaRe = /<Metadata>([\s\S]*?)<\/Metadata>/g;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = metaRe.exec(playlist)) !== null) {
      i += 1;
      const didl = decodeEntities(m[1]);
      const t = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(didl);
      const a = /<upnp:artist>([\s\S]*?)<\/upnp:artist>/.exec(didl);
      items.push({
        index: i,
        title: t ? decodeEntities(t[1]) : `Track ${i}`,
        artist: a ? decodeEntities(a[1]) : '',
      });
    }
    return {listName, items};
  }

  // Jump to a 1-based position in an existing named queue.
  async playIndex(listName: string, index: number): Promise<void> {
    await this.playQueueSoap(
      'PlayQueueWithIndex',
      `<QueueName>${xText(listName)}</QueueName><Index>${index}</Index>`,
    );
  }

  // LinkPlay loop modes: 1 single, 2 shuffle+repeat, 3 shuffle, 4 sequence.
  async setLoopMode(mode: number): Promise<void> {
    await this.command(`setPlayerCmd:loopmode:${mode}`);
  }

  // Append more tracks to the existing WiiMTV queue WITHOUT interrupting
  // playback (used by station auto-refill). AppendTracksInQueue takes the same
  // QueueContext as CreateQueue; the device merges its Tracks into the queue
  // whose ListName matches (QUEUE_NAME).
  async appendQueue(tracks: QueueTrack[]): Promise<void> {
    if (!tracks.length) {
      return;
    }
    const ctx = buildQueueContext(QUEUE_NAME, tracks);
    await this.playQueueSoap(
      'AppendTracksInQueue',
      `<QueueContext>${htmlEsc(ctx)}</QueueContext>`,
    );
  }

  async playAlbumQueue(tracks: QueueTrack[], startIndex = 0): Promise<void> {
    if (!tracks.length) {
      return;
    }
    const ctx = buildQueueContext(QUEUE_NAME, tracks);
    await this.playQueueSoap(
      'CreateQueue',
      `<QueueContext>${htmlEsc(ctx)}</QueueContext>`,
    );
    // Index is 1-based on the device.
    await this.playQueueSoap(
      'PlayQueueWithIndex',
      `<QueueName>${xText(QUEUE_NAME)}</QueueName>` +
        `<Index>${startIndex + 1}</Index>`,
    );
  }
}

export {decodeHex};
