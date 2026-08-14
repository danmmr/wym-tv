import axios from 'axios';
import {randomOrderEnabled} from '../config/display';
import {PLEX} from '../config/plex';
import type {QueueTrack} from './wiim';

// Minimal Plex client for the music library. We request JSON (Plex
// content-negotiates on the Accept header; axios defaults to JSON, and JSON is
// far cleaner to parse in React Native than XML — no DOMParser needed).

export interface PlexAlbum {
  ratingKey: string;
  title: string;
  artist: string;
  artistKey: string; // Plex parentRatingKey (artist id) — stable grouping key
  thumb: string; // raw thumb path, e.g. /library/metadata/123/thumb/456
  year: string;
}

export interface PlexArtist {
  key: string; // artistKey (parentRatingKey), or the name if missing
  name: string;
  count: number; // number of albums
  thumb: string; // a representative album thumb
}

export interface PlexTrack {
  ratingKey: string; // numeric id; /library/metadata/<id> form built where needed
  title: string;
  artist: string;
  album: string;
  durationMs: string;
  bitrate: string;
  url: string; // full streamable URL incl. token
}

// The token is OPTIONAL (see src/config/plex.ts). A Plex server that allows
// unauthenticated access on the LAN serves metadata, artwork AND media parts
// with no token at all — verified against this server, negative controls
// included: a media part returns 206 with a real token and 206 with none, but
// 503 with a WRONG one. So a stale token is the only way to break streaming,
// which is exactly what broke on 2026-08-02. Empty means send nothing; set a
// token only if the server actually requires one.
const tokenQuery = PLEX.token ? `X-Plex-Token=${PLEX.token}` : '';

// Append the token to a URL that already has a query string, or nothing at all
// when no token is configured (a trailing "&" or "?" would be sent verbatim).
function withToken(url: string, sep: '?' | '&'): string {
  return tokenQuery ? `${url}${sep}${tokenQuery}` : url;
}

// Transcoded square cover art. size ~320 for grid thumbs, ~1000 for full art.
export function artUrl(thumb: string, size = 1000): string {
  if (!thumb) {
    return '';
  }
  return withToken(
    `${PLEX.baseUrl}/photo/:/transcode?width=${size}&height=${size}` +
      `&url=${encodeURIComponent(thumb)}&format=jpeg`,
    '&',
  );
}

export function streamUrl(partKey: string): string {
  return withToken(`${PLEX.baseUrl}${partKey}`, '?');
}

// GET a Plex path and return its MediaContainer. Force JSON explicitly so a
// future axios default change can't silently flip us back to XML.
async function plexGet(path: string): Promise<any> {
  const sep = path.indexOf('?') === -1 ? '?' : '&';
  const url = withToken(`${PLEX.baseUrl}${path}`, sep);
  const res = await axios.get(url, {
    headers: {Accept: 'application/json'},
    timeout: 15000,
  });
  return (res.data && res.data.MediaContainer) || {};
}

const str = (v: any, fallback = ''): string =>
  v === undefined || v === null ? fallback : String(v);

// --- album catalog (cached in-session for a stable random order) ------------
// albumCache is the COMPLETE catalog. It backs getArtists()/getAlbumsByArtist()
// and the Search tab, so it must never be seeded with a partial result. It is
// now loaded lazily — only the tabs that genuinely need every album pay for it.
let albumCache: PlexAlbum[] | null = null;
let sampleCache: PlexAlbum[] | null = null;

const PAGE = 800;

export async function loadAllAlbums(
  onProgress?: (loaded: number, total: number) => void,
): Promise<PlexAlbum[]> {
  if (albumCache) {
    return albumCache;
  }

  const all: PlexAlbum[] = [];
  let start = 0;
  let total = Infinity;

  while (start < total) {
    const mc = await plexGet(
      `/library/sections/${PLEX.musicSection}/all` +
        '?type=9&excludeFields=summary' +
        `&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}`,
    );
    if (total === Infinity) {
      total = mc.totalSize ?? mc.size ?? 0;
    }
    const items: any[] = mc.Metadata || [];
    for (const d of items) {
      if (d.ratingKey == null) {
        continue;
      }
      all.push({
        ratingKey: str(d.ratingKey),
        title: str(d.title),
        artist: str(d.parentTitle), // Plex: album's artist is parentTitle
        artistKey: str(d.parentRatingKey),
        thumb: str(d.thumb),
        year: str(d.year),
      });
    }
    start += PAGE;
    onProgress?.(all.length, total === Infinity ? all.length : total);
    if (items.length === 0) {
      break;
    } // safety against an endless loop
  }

  albumCache = all;
  return all;
}

// Deterministic PRNG so the shuffle is stable once generated for the session.
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// How many albums the Albums grid shows. A sample, not the catalog.
export const ALBUM_SAMPLE = 500;

// Fisher-Yates over a copy, seeded from the session's own entropy. Shared by
// the album sample and the artist roster so both shuffle identically.
function shuffled<T>(items: T[]): T[] {
  const rng = mulberry32((Math.random() * 0xffffffff) >>> 0);
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

const byName = (x: string, y: string): number =>
  x.localeCompare(y, undefined, {sensitivity: 'base'});

// A bounded sample of the library for the Albums grid. With RANDOM_ORDER = 1
// (the default) Plex's own sort=random does the sampling server-side, so this
// is ONE request instead of paging the whole catalog (~4.5k albums = 6
// sequential round trips), and holds a fraction of the objects — which matters
// on a 1.7 GB stick. With RANDOM_ORDER = 0 the same single request is made
// against sort=titleSort, giving the first `count` albums alphabetically.
//
// Cached for the session so navigating in and out of the grid keeps the same
// layout, exactly as the previous full-catalog shuffle did.
//
// Deliberately does NOT populate albumCache: that is the complete-catalog cache
// behind the Artists roster, per-artist discographies and Search, and seeding it
// with a 500-album sample would silently truncate all three.
export async function getAlbumSample(
  count = ALBUM_SAMPLE,
): Promise<PlexAlbum[]> {
  if (sampleCache) {
    return sampleCache;
  }
  // If the full catalog already happens to be in memory (Artists or Search was
  // opened first), sample from it rather than making another round trip.
  if (albumCache && albumCache.length) {
    const ordered = randomOrderEnabled()
      ? shuffled(albumCache)
      : albumCache.slice().sort((a, b) => byName(a.title, b.title));
    sampleCache = ordered.slice(0, count);
    return sampleCache;
  }
  const mc = await plexGet(
    `/library/sections/${PLEX.musicSection}/all` +
      '?type=9&excludeFields=summary' +
      `&sort=${randomOrderEnabled() ? 'random' : 'titleSort'}` +
      `&X-Plex-Container-Start=0&X-Plex-Container-Size=${count}`,
  );
  const out: PlexAlbum[] = [];
  for (const d of mc.Metadata || []) {
    if (d.ratingKey == null) {
      continue;
    }
    out.push({
      ratingKey: str(d.ratingKey),
      title: str(d.title),
      artist: str(d.parentTitle),
      artistKey: str(d.parentRatingKey),
      thumb: str(d.thumb),
      year: str(d.year),
    });
  }
  sampleCache = out;
  return out;
}

// Drop the cached orderings so the next Browse open recomputes them (kept for a
// future "reshuffle" affordance). With RANDOM_ORDER = 1 that redraws a fresh
// 500 from the library; with 0 it rebuilds the same alphabetical list.
export function reshuffle(): void {
  sampleCache = null;
  shuffledArtistsCache = null;
}

// --- artists (derived in-memory from the album catalog) ---------------------
let artistsCache: PlexArtist[] | null = null;
let shuffledArtistsCache: PlexArtist[] | null = null;

// Unique artists, alphabetised. Built from the already-loaded album cache, so
// this costs nothing beyond the album fetch — no extra Plex calls.
export async function getArtists(
  onProgress?: (loaded: number, total: number) => void,
): Promise<PlexArtist[]> {
  if (artistsCache) {
    return artistsCache;
  }
  const albums = await loadAllAlbums(onProgress);
  const map = new Map<string, PlexArtist>();
  for (const a of albums) {
    const key = a.artistKey || a.artist;
    if (!key) {
      continue;
    }
    const ex = map.get(key);
    if (ex) {
      ex.count++;
      if (!ex.thumb && a.thumb) {
        ex.thumb = a.thumb;
      }
    } else {
      map.set(key, {
        key,
        name: a.artist || 'Unknown Artist',
        count: 1,
        thumb: a.thumb,
      });
    }
  }
  artistsCache = Array.from(map.values()).sort((x, y) => byName(x.name, y.name));
  return artistsCache;
}

// How many artists the Artists grid shows. A sample, not the whole roster —
// same bound and same reasoning as ALBUM_SAMPLE.
export const ARTIST_SAMPLE = 500;

// The roster the Artists tab displays (mirrors getAlbumSample): at most
// ARTIST_SAMPLE artists. With RANDOM_ORDER = 1 that is a random draw from the
// full roster in a random order; with 0 it is the first ARTIST_SAMPLE
// alphabetically. Either way the result is computed once per session and
// cached, so navigating in and out of the tab keeps the same grid.
//
// The cap is display-only. getArtists() still returns every artist, and the
// Search tab still searches the complete album catalog, so nothing becomes
// unreachable — a capped-out artist is still found by searching their albums.
//
// Name kept as getShuffledArtists so the Browse call sites and their refs stay
// put; "shuffled" is now the default case rather than the only one.
export async function getShuffledArtists(
  onProgress?: (loaded: number, total: number) => void,
  count = ARTIST_SAMPLE,
): Promise<PlexArtist[]> {
  if (shuffledArtistsCache) {
    return shuffledArtistsCache;
  }
  const artists = await getArtists(onProgress);
  // slice() on the ordered path too, so this cache never aliases artistsCache.
  const ordered = randomOrderEnabled() ? shuffled(artists) : artists.slice();
  shuffledArtistsCache = ordered.slice(0, count);
  return shuffledArtistsCache;
}

// All releases by one artist (by artistKey), oldest first. Pure in-memory
// filter over the cached catalog.
export function getAlbumsByArtist(key: string): PlexAlbum[] {
  if (!albumCache) {
    return [];
  }
  return albumCache
    .filter(a => (a.artistKey || a.artist) === key)
    .sort(
      (x, y) =>
        (x.year || '').localeCompare(y.year || '') ||
        x.title.localeCompare(y.title, undefined, {sensitivity: 'base'}),
    );
}

// --- track artist -----------------------------------------------------------
// A track's `grandparentTitle` is the ALBUM artist, which on a compilation is
// the "Various Artists" placeholder rather than whoever actually performed the
// track. Plex keeps the real per-track credit in `originalTitle` (populated
// whenever it differs from the album artist). So: on a Various-Artists album,
// prefer originalTitle; everywhere else keep grandparentTitle, which is the
// canonical artist name — originalTitle on a normal album is usually absent
// and when present is a variant spelling or a "feat." credit we don't want
// replacing the artist name.
const VARIOUS_RE = /^\s*various(\s*artists?)?\s*$/i;

export function trackArtist(t: any): string {
  const albumArtist = str(t.grandparentTitle);
  if (VARIOUS_RE.test(albumArtist)) {
    return str(t.originalTitle) || albumArtist;
  }
  return albumArtist;
}

// --- album tracks (for building the WiiM play queue) ------------------------
export async function getAlbumTracks(ratingKey: string): Promise<PlexTrack[]> {
  const mc = await plexGet(`/library/metadata/${ratingKey}/children`);
  const items: any[] = mc.Metadata || [];
  const tracks: PlexTrack[] = [];
  for (const t of items) {
    const media = (t.Media && t.Media[0]) || {};
    const part = (media.Part && media.Part[0]) || {};
    if (!part.key) {
      continue;
    }
    tracks.push({
      ratingKey: str(t.ratingKey),
      title: str(t.title),
      artist: trackArtist(t),
      album: str(t.parentTitle),
      durationMs: str(t.duration, '0'),
      bitrate: str(media.bitrate, '320'),
      url: streamUrl(part.key),
    });
  }
  return tracks;
}

// Map one Plex track object (as returned by any /library or /playlists query)
// onto a WiiM QueueTrack. Returns null for tracks with no playable part, which
// callers skip. Every "build a queue from a track list" path shares this so the
// metadata the WiiM displays is identical no matter where the queue came from.
function toQueueTrack(t: any): QueueTrack | null {
  const media = (t.Media && t.Media[0]) || {};
  const part = (media.Part && media.Part[0]) || {};
  if (!part.key) {
    return null;
  }
  const albumRk = str(t.parentRatingKey);
  const thumb = str(t.parentThumb || t.grandparentThumb || t.thumb);
  return {
    url: streamUrl(part.key),
    trackId: t.ratingKey != null ? `/library/metadata/${t.ratingKey}` : '',
    albumId: albumRk ? `/library/metadata/${albumRk}/children` : '',
    title: str(t.title),
    artist: trackArtist(t),
    album: str(t.parentTitle),
    durationMs: str(t.duration, '0'),
    bitrate: str(media.bitrate, '320'),
    artUrl: thumb ? artUrl(thumb, 1000) : '',
  };
}

// Build the WiiM native play-queue for an album. Shared by Browse's "play
// album" and Now Playing's "Feeling lucky?" so the queue is built one way.
// Note this one does NOT use toQueueTrack: every track gets the ALBUM's art,
// which is correct here and avoids per-track thumb variation within an album.
export async function buildAlbumQueue(album: PlexAlbum): Promise<QueueTrack[]> {
  const tracks = await getAlbumTracks(album.ratingKey);
  const art = artUrl(album.thumb, 1000);
  const albumId = `/library/metadata/${album.ratingKey}/children`;
  return tracks.map(t => ({
    url: t.url,
    trackId: t.ratingKey ? `/library/metadata/${t.ratingKey}` : '',
    albumId,
    title: t.title,
    artist: t.artist,
    album: t.album,
    durationMs: t.durationMs,
    bitrate: t.bitrate,
    artUrl: art,
  }));
}

// Per-track details Plex knows and the WiiM doesn't: the audio codec, and the
// real artist on a compilation (the queue metadata the WiiM echoes back can
// only be as good as whatever pushed it — a queue built before the
// compilation fix, or pushed by another app, still says "Various Artists").
// `idOrPath` is the metaInfo trackId ("/library/metadata/123") or a bare
// rating key. Fields are '' when unknown. One request serves both.
const CODEC_LABEL: Record<string, string> = {
  flac: 'FLAC',
  alac: 'ALAC',
  mp3: 'MP3',
  aac: 'AAC',
  wav: 'WAV',
  aiff: 'AIFF',
  dsd: 'DSD',
  dsf: 'DSD',
  ape: 'APE',
  opus: 'Opus',
  ogg: 'OGG',
  vorbis: 'OGG',
  wma: 'WMA',
  pcm: 'PCM',
};

export interface PlexTrackInfo {
  codec: string;
  artist: string;
  // The album this track belongs to. Free: the same request that carries the
  // codec already carries the parent album, so Now Playing's "Album" button
  // costs no extra Plex call. All '' when Plex doesn't say.
  albumKey: string; // parentRatingKey — the album's rating key
  albumTitle: string; // parentTitle
  albumArtist: string; // grandparentTitle — see the note below
  albumThumb: string; // parentThumb — RAW path; artUrl() builds the transcode
}

export async function getTrackInfo(idOrPath: string): Promise<PlexTrackInfo> {
  const empty = {
    codec: '',
    artist: '',
    albumKey: '',
    albumTitle: '',
    albumArtist: '',
    albumThumb: '',
  };
  if (!idOrPath) {
    return empty;
  }
  const path = idOrPath.startsWith('/')
    ? idOrPath
    : `/library/metadata/${idOrPath}`;
  const mc = await plexGet(path);
  const t = (mc.Metadata || [])[0];
  if (!t) {
    return empty;
  }
  const codec = t.Media?.[0]?.audioCodec;
  const albumKey = str(t.parentRatingKey);
  return {
    codec: codec
      ? CODEC_LABEL[String(codec).toLowerCase()] || String(codec).toUpperCase()
      : '',
    artist: trackArtist(t),
    albumKey,
    albumTitle: albumKey ? str(t.parentTitle) : '',
    // Deliberately grandparentTitle and NOT trackArtist(t): on a compilation
    // trackArtist returns the per-track credit, which is the right label for
    // the TRACK and the wrong one for the album as a whole.
    albumArtist: albumKey ? str(t.grandparentTitle) : '',
    albumThumb: albumKey ? str(t.parentThumb) : '',
  };
}

// --- "radio" stations (no Sonic Analysis) -----------------------------------
// Replicates Plex's Library Radio / Deep Cuts as plain track queries, then
// builds a finite WiiM queue from the result (the WiiM queue can't be endless).
//   library  = random tracks across the whole library
//   deepcuts = random tracks that have never been played (viewCount=0)
export type StationKind = 'library' | 'deepcuts';

export async function buildStationQueue(
  kind: StationKind,
  size = 50,
): Promise<QueueTrack[]> {
  const filter = kind === 'deepcuts' ? '&viewCount=0' : '';
  const mc = await plexGet(
    `/library/sections/${PLEX.musicSection}/all` +
      `?type=10&sort=random${filter}` +
      `&X-Plex-Container-Start=0&X-Plex-Container-Size=${size}`,
  );
  const queue: QueueTrack[] = [];
  for (const t of mc.Metadata || []) {
    const qt = toQueueTrack(t);
    if (qt) {
      queue.push(qt);
    }
  }
  return queue;
}

// Most recently ADDED albums, newest first — for the Browse "Recent" tab.
// Deliberately NOT cached: reopening the tab should reflect fresh imports.
// Same album shape as loadAllAlbums so the existing grid/play path just works.
export async function getRecentlyAddedAlbums(
  limit = 100,
): Promise<PlexAlbum[]> {
  const mc = await plexGet(
    `/library/sections/${PLEX.musicSection}/all` +
      '?type=9&excludeFields=summary&sort=addedAt:desc' +
      `&X-Plex-Container-Start=0&X-Plex-Container-Size=${limit}`,
  );
  const items: any[] = mc.Metadata || [];
  const out: PlexAlbum[] = [];
  for (const d of items) {
    if (d.ratingKey == null) {
      continue;
    }
    out.push({
      ratingKey: str(d.ratingKey),
      title: str(d.title),
      artist: str(d.parentTitle),
      artistKey: str(d.parentRatingKey),
      thumb: str(d.thumb),
      year: str(d.year),
    });
  }
  return out;
}

// Shuffled queue drawn from the most recently ADDED tracks — the "random play"
// for the Recent tab. Pulls a wider pool of recent tracks than we need, then
// Fisher-Yates shuffles and caps to `size` so each shuffle differs. Recently
// added tracks cluster into recently added albums, so this is effectively
// "shuffle my new music."
export async function buildRecentQueue(size = 60): Promise<QueueTrack[]> {
  const pool = Math.max(size * 3, 120);
  const mc = await plexGet(
    `/library/sections/${PLEX.musicSection}/all` +
      '?type=10&sort=addedAt:desc' +
      `&X-Plex-Container-Start=0&X-Plex-Container-Size=${pool}`,
  );
  const queue: QueueTrack[] = [];
  for (const t of mc.Metadata || []) {
    const qt = toQueueTrack(t);
    if (qt) {
      queue.push(qt);
    }
  }
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = queue[i];
    queue[i] = queue[j];
    queue[j] = tmp;
  }
  return queue.slice(0, size);
}

// --- playlists --------------------------------------------------------------

export interface PlexPlaylist {
  ratingKey: string;
  title: string;
  count: number; // leafCount — number of tracks
  smart: boolean; // Plex "smart" (rule-based) vs a hand-built playlist
  thumb: string; // composite mosaic path, may be '' for an empty playlist
}

// Largest queue we will push to the WiiM for one playlist. Smart playlists can
// be enormous (tens of thousands of tracks); the WiiM queue is finite and
// building the QueueContext XML for all of them would be slow and pointless.
// Playlists are played in their stored order, so this takes the first N.
export const PLAYLIST_MAX = 200;

// All audio playlists, alphabetical. Empty ones are kept — they show a "0
// tracks" count rather than silently vanishing, which is less confusing than
// wondering where a playlist went.
export async function getPlaylists(): Promise<PlexPlaylist[]> {
  const mc = await plexGet('/playlists?playlistType=audio');
  const out: PlexPlaylist[] = [];
  for (const p of mc.Metadata || []) {
    if (p.ratingKey == null) {
      continue;
    }
    out.push({
      ratingKey: str(p.ratingKey),
      title: str(p.title),
      count: Number(p.leafCount) || 0,
      smart: Boolean(p.smart),
      thumb: str(p.composite),
    });
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

// Tracks of one playlist as a WiiM queue, in playlist order, capped at `size`.
export async function buildPlaylistQueue(
  ratingKey: string,
  size = PLAYLIST_MAX,
): Promise<QueueTrack[]> {
  const mc = await plexGet(
    `/playlists/${ratingKey}/items` +
      `?X-Plex-Container-Start=0&X-Plex-Container-Size=${size}`,
  );
  const queue: QueueTrack[] = [];
  for (const t of mc.Metadata || []) {
    const qt = toQueueTrack(t);
    if (qt) {
      queue.push(qt);
    }
  }
  return queue;
}

// A batch of random albums, for the art-frame slideshow. Prefers the cached
// catalog (Browse already loaded it) and otherwise asks Plex for one random
// page — one request per batch rather than one per slide.
export async function getRandomAlbums(count = 30): Promise<PlexAlbum[]> {
  const pick = (pool: PlexAlbum[]) => {
    const out = pool.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out.slice(0, count);
  };
  if (albumCache && albumCache.length) {
    return pick(albumCache);
  }
  const mc = await plexGet(
    `/library/sections/${PLEX.musicSection}/all` +
      '?type=9&excludeFields=summary&sort=random' +
      `&X-Plex-Container-Start=0&X-Plex-Container-Size=${count}`,
  );
  const out: PlexAlbum[] = [];
  for (const d of mc.Metadata || []) {
    if (d.ratingKey == null || !d.thumb) {
      continue;
    }
    out.push({
      ratingKey: str(d.ratingKey),
      title: str(d.title),
      artist: str(d.parentTitle),
      artistKey: str(d.parentRatingKey),
      thumb: str(d.thumb),
      year: str(d.year),
    });
  }
  return out;
}

// A single random album. If the full catalog is already cached (Browse was
// opened) we pick from it instantly; otherwise ask Plex for one random album
// (sort=random, size=1) — fast, no need to load all ~3800 first.
export async function getRandomAlbum(): Promise<PlexAlbum | null> {
  if (albumCache && albumCache.length) {
    return albumCache[Math.floor(Math.random() * albumCache.length)];
  }
  const mc = await plexGet(
    `/library/sections/${PLEX.musicSection}/all` +
      '?type=9&excludeFields=summary&sort=random' +
      '&X-Plex-Container-Start=0&X-Plex-Container-Size=1',
  );
  const d = (mc.Metadata || [])[0];
  if (!d || d.ratingKey == null) {
    return null;
  }
  return {
    ratingKey: str(d.ratingKey),
    title: str(d.title),
    artist: str(d.parentTitle),
    artistKey: str(d.parentRatingKey),
    thumb: str(d.thumb),
    year: str(d.year),
  };
}
