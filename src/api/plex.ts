import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

// --- album catalog (cached in-session AND on disk) --------------------------
// albumCache is the COMPLETE catalog. It backs getArtists()/getAlbumsByArtist()
// and the Search tab, so it must never be seeded with a partial result. It is
// loaded lazily — only the tabs that genuinely need every album pay for it —
// and it is mirrored to AsyncStorage so a cold app start does not re-page the
// whole library over wifi.
let albumCache: PlexAlbum[] | null = null;
let sampleCache: PlexAlbum[] | null = null;

const PAGE = 800;

// Fields Plex sends by default that this client never reads. Excluding them
// roughly HALVES the wire payload (measured against a real server: 710 KB ->
// 331 KB for an 800-album page), and on a Fire Stick the JSON parse — not the
// transfer — is the expensive half. Anything mapped into PlexAlbum below must
// stay OFF this list.
const EXCLUDE_FIELDS =
  'summary,guid,parentGuid,titleSort,studio,originallyAvailableAt,art,' +
  'rating,loudnessAnalysisVersion,index,key,parentKey,parentThumb,' +
  'addedAt,updatedAt,lastViewedAt,viewCount,skipCount';

// The one query string used for every album page, sample included, so the
// exclusion list can never drift between the two call sites.
export const ALBUM_QUERY = `type=9&excludeFields=${EXCLUDE_FIELDS}`;

function toAlbum(d: any): PlexAlbum {
  return {
    ratingKey: str(d.ratingKey),
    title: str(d.title),
    artist: str(d.parentTitle), // Plex: album's artist is parentTitle
    artistKey: str(d.parentRatingKey),
    thumb: str(d.thumb),
    year: str(d.year),
  };
}

// --- disk cache -------------------------------------------------------------
// Serialized the catalog is small: only the six mapped fields are stored, which
// measures ~160 bytes per album, so even a large library sits well inside
// AsyncStorage's 6 MB Android budget. Past ~30k albums, raise
// AsyncStorage_db_size_in_MB in android/gradle.properties rather than dropping
// the cache.
const CATALOG_KEY = 'plex.catalog.v1';

interface CachedCatalog {
  fingerprint: string;
  albums: PlexAlbum[];
}

// A cheap token that changes whenever the music library's contents change.
// /library/sections answers in ~30 ms (vs ~1.1 s for a Container-Size=0 count
// probe, which makes Plex tally the section), so this is the validity check.
// contentChangedAt is the field that actually bumps on an add or a delete;
// scannedAt and updatedAt ride along so an edit that only touches metadata
// still busts the cache.
async function libraryFingerprint(): Promise<string | null> {
  try {
    const mc = await plexGet('/library/sections');
    const dirs: any[] = mc.Directory || [];
    const sec = dirs.find(d => str(d.key) === String(PLEX.musicSection));
    if (!sec) {
      return null;
    }
    return `${str(sec.contentChangedAt, '0')}:${str(sec.scannedAt, '0')}:${str(
      sec.updatedAt,
      '0',
    )}`;
  } catch {
    return null; // server unreachable — fall back to whatever is on disk
  }
}

// One probe per session, shared by the catalog and the collection cache. Both
// are invalidated by the same library change, so probing twice would be waste.
let fingerprintPromise: Promise<string | null> | null = null;
function currentFingerprint(): Promise<string | null> {
  if (!fingerprintPromise) {
    fingerprintPromise = libraryFingerprint();
  }
  return fingerprintPromise;
}

async function readCachedCatalog(): Promise<CachedCatalog | null> {
  try {
    const raw = await AsyncStorage.getItem(CATALOG_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.fingerprint !== 'string' ||
      !Array.isArray(parsed.albums) ||
      !parsed.albums.length
    ) {
      return null;
    }
    return parsed as CachedCatalog;
  } catch {
    return null; // corrupt or truncated entry — just re-fetch
  }
}

// Fire-and-forget: a failed write only costs the next launch a re-fetch.
function writeCachedCatalog(fingerprint: string, albums: PlexAlbum[]): void {
  AsyncStorage.setItem(
    CATALOG_KEY,
    JSON.stringify({fingerprint, albums} as CachedCatalog),
  ).catch(() => {});
}

// Drop the on-disk catalog. Not called in the normal flow — the fingerprint
// handles staleness — but the escape hatch if a cache is ever suspected bad.
export async function clearCatalogCache(): Promise<void> {
  albumCache = null;
  artistsCache = null;
  shuffledArtistsCache = null;
  collectionCache.clear();
  collectionKeyCache = null;
  fingerprintPromise = null;
  await AsyncStorage.multiRemove([CATALOG_KEY, COLLECTIONS_KEY]).catch(
    () => {},
  );
}

// One page of albums, mapped. Pages are fetched by index so a parallel run can
// still reassemble them in the server's order.
async function fetchAlbumPage(page: number): Promise<{
  albums: PlexAlbum[];
  total: number;
}> {
  const mc = await plexGet(
    `/library/sections/${PLEX.musicSection}/all?${ALBUM_QUERY}` +
      `&X-Plex-Container-Start=${page * PAGE}&X-Plex-Container-Size=${PAGE}`,
  );
  const items: any[] = mc.Metadata || [];
  return {
    albums: items.filter(d => d.ratingKey != null).map(toAlbum),
    total: mc.totalSize ?? mc.size ?? items.length,
  };
}

// In-flight guard. Browse prefetches the catalog on mount while a tab entry can
// ask for it too; without this, two overlapping callers would each page the
// whole library, since albumCache is only set once the last page lands.
let loadPromise: Promise<PlexAlbum[]> | null = null;

export function loadAllAlbums(
  onProgress?: (loaded: number, total: number) => void,
): Promise<PlexAlbum[]> {
  if (albumCache) {
    return Promise.resolve(albumCache);
  }
  if (!loadPromise) {
    loadPromise = fetchAllAlbums(onProgress).finally(() => {
      loadPromise = null;
    });
  }
  return loadPromise;
}

async function fetchAllAlbums(
  onProgress?: (loaded: number, total: number) => void,
): Promise<PlexAlbum[]> {
  // Warm path: a fingerprint match means the disk copy is current, and the
  // whole paged fetch is skipped.
  const fingerprint = await currentFingerprint();
  const cached = await readCachedCatalog();
  if (cached && (fingerprint === null || cached.fingerprint === fingerprint)) {
    albumCache = cached.albums;
    onProgress?.(albumCache.length, albumCache.length);
    return albumCache;
  }

  // Cold path. Page 0 tells us the total, and the remaining pages then go out
  // together instead of one round trip at a time.
  const first = await fetchAlbumPage(0);
  const total = first.total;
  onProgress?.(first.albums.length, total || first.albums.length);

  const pages: PlexAlbum[][] = [first.albums];
  const rest = Math.max(0, Math.ceil(total / PAGE) - 1);
  if (rest > 0) {
    let loaded = first.albums.length;
    const results = await Promise.all(
      Array.from({length: rest}, (_v, i) =>
        fetchAlbumPage(i + 1).then(r => {
          loaded += r.albums.length;
          onProgress?.(loaded, total);
          return r.albums;
        }),
      ),
    );
    pages.push(...results);
  }

  const all = ([] as PlexAlbum[]).concat(...pages);
  albumCache = all;
  if (fingerprint && all.length) {
    writeCachedCatalog(fingerprint, all);
  }
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
    `/library/sections/${PLEX.musicSection}/all?${ALBUM_QUERY}` +
      `&sort=${randomOrderEnabled() ? 'random' : 'titleSort'}` +
      `&X-Plex-Container-Start=0&X-Plex-Container-Size=${count}`,
  );
  const out: PlexAlbum[] = (mc.Metadata || [])
    .filter((d: any) => d.ratingKey != null)
    .map(toAlbum);
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
  artistsCache = Array.from(map.values()).sort((x, y) =>
    byName(x.name, y.name),
  );
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

// --- collections ------------------------------------------------------------

export interface PlexCollection {
  ratingKey: string;
  title: string;
  count: number; // childCount — number of albums
  smart: boolean; // Plex "smart" (rule-based) vs a hand-built collection
  thumb: string; // mosaic path, may be '' for an empty collection
}

// All ALBUM collections in the music section, alphabetical.
//
// Only subtype 'album' is kept: a music collection can in principle hold
// artists, and those children are not PlexAlbums, so the album grid would
// render blank cards for them. Not cached — collections are edited on the
// server, and this is one small request.
export async function getCollections(): Promise<PlexCollection[]> {
  const mc = await plexGet(
    `/library/sections/${PLEX.musicSection}/collections`,
  );
  const out: PlexCollection[] = [];
  for (const c of mc.Metadata || []) {
    if (c.ratingKey == null || str(c.subtype) !== 'album') {
      continue;
    }
    out.push({
      ratingKey: str(c.ratingKey),
      title: str(c.title),
      count: Number(c.childCount) || 0,
      // Plex sends smart as "1"/"0" here, not a JSON boolean, so String('0')
      // would be truthy — compare explicitly.
      smart: str(c.smart) === '1',
      // A collection's cover mosaic arrives as `thumb` — NOT `composite`, the
      // field the /playlists endpoint uses for the same idea. Reading composite
      // here left every card on its letter placeholder. Both are accepted so a
      // server that sends the playlist-style field still shows art.
      thumb: str(c.thumb) || str(c.composite),
    });
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

// Albums of one collection, in the server's stored order. Paged: the largest
// here run to ~1.5k albums, well past one container.
//
// Cached per collection for the session — unlike the playlist list (one cheap
// request), re-entering a big collection would otherwise re-page a thousand-plus
// albums every time. Reopening Browse gets a fresh process, so server-side edits
// still show up on the next app start.
const collectionCache = new Map<string, PlexAlbum[]>();

// --- collection membership, cached on disk ----------------------------------
// The big collections here run to ~1,500 albums over two pages, and that was
// re-paged on the first drill-in of every session. It is cached now, but what
// is STORED is only the rating keys: a collection's children are all albums
// that the catalog already holds, so persisting them again would duplicate
// ~160 bytes per album for nothing. Keys cost ~7 bytes each, and rehydrating
// through the catalog means the two can never disagree about an album's title
// or art.
//
// NOT derived from the catalog's own `Collection` tags, which would need no
// storage at all: Plex caps the tag list it returns per item, so that
// reproduced "New Additions" exactly (1505/1505) but silently returned 128 of
// 297 for a smaller collection. A collection that quietly loses half its
// albums has no visible symptom, so membership comes from the server.
const COLLECTIONS_KEY = 'plex.collections.v1';

interface CachedCollections {
  fingerprint: string;
  keys: Record<string, string[]>; // collection ratingKey -> album ratingKeys
}

let collectionKeyCache: Record<string, string[]> | null = null;

// Load the persisted membership map once per session, discarding it unless the
// library still matches the fingerprint it was written under.
async function collectionKeys(): Promise<Record<string, string[]>> {
  if (collectionKeyCache) {
    return collectionKeyCache;
  }
  collectionKeyCache = {};
  try {
    const [raw, fingerprint] = await Promise.all([
      AsyncStorage.getItem(COLLECTIONS_KEY),
      currentFingerprint(),
    ]);
    if (raw && fingerprint) {
      const parsed = JSON.parse(raw) as CachedCollections;
      if (parsed?.fingerprint === fingerprint && parsed.keys) {
        collectionKeyCache = parsed.keys;
      }
    }
  } catch {
    // corrupt entry, or no server to validate against — start empty
  }
  return collectionKeyCache;
}

async function rememberCollection(
  ratingKey: string,
  albums: PlexAlbum[],
): Promise<void> {
  const fingerprint = await currentFingerprint();
  if (!fingerprint) {
    return; // unverifiable, so not worth persisting
  }
  const keys = await collectionKeys();
  keys[ratingKey] = albums.map(a => a.ratingKey);
  AsyncStorage.setItem(
    COLLECTIONS_KEY,
    JSON.stringify({fingerprint, keys} as CachedCollections),
  ).catch(() => {});
}

// All albums in one collection, in the collection's own order.
export async function getCollectionAlbums(
  ratingKey: string,
): Promise<PlexAlbum[]> {
  const hit = collectionCache.get(ratingKey);
  if (hit) {
    return hit;
  }

  // Warm path: stored keys, resolved against the catalog. Any key the catalog
  // does not know means the two are out of step, so the whole entry is dropped
  // and re-fetched rather than handing back a collection missing albums.
  const stored = (await collectionKeys())[ratingKey];
  if (stored && stored.length) {
    const catalog = await loadAllAlbums();
    const byKey = new Map(catalog.map(a => [a.ratingKey, a]));
    const resolved: PlexAlbum[] = [];
    let intact = true;
    for (const k of stored) {
      const album = byKey.get(k);
      if (!album) {
        intact = false;
        break;
      }
      resolved.push(album);
    }
    if (intact) {
      collectionCache.set(ratingKey, resolved);
      return resolved;
    }
  }

  const all: PlexAlbum[] = [];
  let start = 0;
  let total = Infinity;

  while (start < total) {
    const mc = await plexGet(
      `/library/collections/${ratingKey}/children?${ALBUM_QUERY}` +
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
      all.push(toAlbum(d));
    }
    if (!items.length) {
      break; // defensive: never loop forever on an unexpected empty page
    }
    start += items.length;
  }

  collectionCache.set(ratingKey, all);
  rememberCollection(ratingKey, all).catch(() => {});
  return all;
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
