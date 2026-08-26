import React, {useCallback, useState, useEffect, useRef, useMemo} from 'react';
import {
  BackHandler,
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import {captureDpad, subscribeNav} from '../nav/dpad';
import {useFocusEffect} from '@react-navigation/native';
import {useDeviceStore} from '../store/deviceStore';
import {WiiMClient} from '../api/wiim';
import {
  getAlbumSample,
  loadAllAlbums,
  getShuffledArtists,
  getAlbumsByArtist,
  getRecentlyAddedAlbums,
  buildRecentQueue,
  buildAlbumQueue,
  getPlaylists,
  buildPlaylistQueue,
  PLAYLIST_MAX,
  getCollections,
  getCollectionAlbums,
  artUrl,
  PlexAlbum,
  PlexArtist,
  PlexPlaylist,
  PlexCollection,
} from '../api/plex';
import {usePlayerStore} from '../store/playerStore';
import {inputsEnabled, presetsEnabled} from '../config/display';
import {fold} from './searchText';
import {navKeyboard, scrollTopFor, KeyCell, TABS} from './browseNav';
import Icon from '../components/Icon';
import type {IconName} from '../components/Icon';
import type {ViewStyle} from 'react-native';
import Focusable from '../components/Focusable';
import {
  color as theme,
  onArt,
  radius,
  space,
  type as typeScale,
} from '../theme';

const {width: SCREEN_W, height: SCREEN_H} = Dimensions.get('window');
const COLS = 5;
const H_PAD = 40; // container horizontal padding
const GAP = 16;
// Room for a focused card to grow without being shaved by the list's clip.
//
// A focused card scales to 1.07. On a 158dp card that is ~5.5dp past each edge,
// and a FlatList clips to its bounds, so the first and last COLUMNS lost a
// sliver exactly as the top ROW did. There was nowhere to take it from: the old
// CARD_W consumed the row to within 1dp (5x163 + 4x16 = 879 of 880 available).
//
// So reserve it in the card width itself and spend it as content padding,
// rather than adding padding on top of a row that is already full — which
// would push the fifth column onto a second line.
const FOCUS_PAD = 12;

const CARD_W = Math.floor(
  (SCREEN_W - H_PAD * 2 - FOCUS_PAD * 2 - GAP * (COLS - 1)) / COLS,
);

// Fixed card geometry so row heights are deterministic — required for exact
// getItemLayout and smooth, row-stepped scrolling.
const CARD_PAD = 6;
const CARD_BORDER = 3;
const ART_H = CARD_W - 2 * (CARD_PAD + CARD_BORDER); // square cover
const CAPTION_H = 42; // title + artist (fixed)
const CARD_H = 2 * CARD_BORDER + 2 * CARD_PAD + ART_H + CAPTION_H;
const ROW_H = CARD_H + GAP; // vertical pitch between rows

// Headroom above the first row, INSIDE each list's content.
//
// A focused card scales to 1.07, which grows it ~7dp past its own top edge, and
// a FlatList clips to its bounds — so the top row was shaved. It only showed up
// once the tab bar was removed, because the bar had been donating the space;
// Recent looked fine throughout only because its Shuffle control sits in it.
//
// It must be LESS THAN GAP. scrollToOffset still targets `top * ROW_H`, so at
// any scrolled row the previous row's bottom lands at (LIST_TOP - GAP) relative
// to the viewport — above it, and therefore invisible, only while this is the
// smaller of the two. At 12 against a 16dp gap there is no peeking row.
const LIST_TOP = 12;

// Roughly how many album rows fit in the list viewport (used to decide when a
// move needs to scroll). Subtracts the tab bar / back button / paddings.
const LIST_H = SCREEN_H - 40 - 66 - 64;
const VISIBLE_ROWS = Math.max(1, Math.floor(LIST_H / ROW_H));

// Artist results list geometry (fixed for exact getItemLayout / windowing).
const RESULT_H = 60;
const RES_VISIBLE = Math.max(1, Math.floor(LIST_H / RESULT_H));

// TABS (which tabs are offered, in bar order) lives in browseNav.ts with the
// rest of the pure navigation data, so it can be unit tested.
const TAB_LABELS: Record<string, string> = {
  albums: 'Albums',
  recent: 'Recent',
  playlists: 'Playlists',
  collections: 'Collections',
  artists: 'Artists',
  presets: 'Presets',
  inputs: 'Inputs',
};

// On-screen keyboard layout. Letter rows are 7 wide; the last row holds the
// action keys (space / delete / clear). Column is clamped to row width when
// moving vertically between rows of different lengths.
type Key = KeyCell;
const letterRow = (s: string): Key[] => s.split('').map(c => ({l: c, v: c}));
// Narrow keys, so ten digits occupy about the same width as seven letters.
const digitRow = (s: string): Key[] =>
  s.split('').map(c => ({l: c, v: c, n: true}));
const KEY_ROWS: Key[][] = [
  letterRow('ABCDEFG'),
  letterRow('HIJKLMN'),
  letterRow('OPQRSTU'),
  letterRow('VWXYZ'),
  // Without this row a title that IS a number — 1983, August 53rd, 17 Years
  // In Ektachrome — could only be reached by a substring that dodged it.
  digitRow('0123456789'),
  [
    {l: 'SPACE', v: ' ', act: 'space'},
    {l: 'DEL', v: '', act: 'del'},
    {l: 'CLEAR', v: '', act: 'clear'},
  ],
];

// Focus zones for the JS-managed D-pad cursor (this app captures the D-pad and
// drives focus in JS rather than relying on native TV focus). The Artists tab
// swaps its content between a shuffled artist grid and one artist's releases.
type Zone = 'landing' | 'content' | 'back';

// The chooser lays TABS out in rows of three. Built from TABS rather than
// hard-coded so the optional Presets/Inputs tabs land in it automatically when
// config/display.ts turns them on.
const CHOOSER_COLS = 3;

const TAB_ICONS: Record<string, IconName> = {
  artists: 'artists',
  albums: 'album',
  recent: 'recent',
  playlists: 'playlists',
  collections: 'collections',
  presets: 'presets',
  inputs: 'inputs',
};

// Memoised album cell: with extraData on the FlatList only the two cards whose
// `focused` flips actually re-render on each cursor move, instead of repainting
// the whole visible grid (which janks on the Fire TV GPU).
const AlbumCard = React.memo(function AlbumCard({
  album,
  focused,
}: {
  album: PlexAlbum;
  focused: boolean;
}) {
  return (
    <View style={[styles.card, focused && styles.cardFocused]}>
      {album.thumb ? (
        <Image
          source={{uri: artUrl(album.thumb, 320)}}
          style={styles.cardArt}
        />
      ) : (
        <View style={[styles.cardArt, styles.cardArtPlaceholder]}>
          <Text style={styles.cardArtPlaceholderText}>
            {(album.title || '?').charAt(0).toUpperCase()}
          </Text>
        </View>
      )}
      <Text style={styles.cardTitle} numberOfLines={1}>
        {album.title}
      </Text>
      <Text style={styles.cardArtist} numberOfLines={1}>
        {album.year || album.artist}
      </Text>
    </View>
  );
});

// Memoised artist cell — same geometry as AlbumCard so the Artists tab reads as
// a grid of artists (thumbnail + name + album count) rather than a search box.
const ArtistCard = React.memo(function ArtistCard({
  artist,
  focused,
}: {
  artist: PlexArtist;
  focused: boolean;
}) {
  return (
    <View style={[styles.card, focused && styles.cardFocused]}>
      {artist.thumb ? (
        <Image
          source={{uri: artUrl(artist.thumb, 320)}}
          style={styles.cardArt}
        />
      ) : (
        <View style={[styles.cardArt, styles.cardArtPlaceholder]}>
          <Text style={styles.cardArtPlaceholderText}>
            {(artist.name || '?').charAt(0).toUpperCase()}
          </Text>
        </View>
      )}
      <Text style={styles.cardTitle} numberOfLines={1}>
        {artist.name}
      </Text>
      <Text style={styles.cardArtist} numberOfLines={1}>
        {artist.count} {artist.count === 1 ? 'album' : 'albums'}
      </Text>
    </View>
  );
});

// Memoised collection cell — same geometry again, so Collections reads as a
// third grid of the same kind. The art is Plex's composite mosaic of the
// collection's covers, which is why an empty collection has no thumb.
const CollectionCard = React.memo(function CollectionCard({
  collection,
  focused,
}: {
  collection: PlexCollection;
  focused: boolean;
}) {
  return (
    <View style={[styles.card, focused && styles.cardFocused]}>
      {collection.thumb ? (
        <Image
          source={{uri: artUrl(collection.thumb, 320)}}
          style={styles.cardArt}
        />
      ) : (
        <View style={[styles.cardArt, styles.cardArtPlaceholder]}>
          <Text style={styles.cardArtPlaceholderText}>
            {(collection.title || '?').charAt(0).toUpperCase()}
          </Text>
        </View>
      )}
      <Text style={styles.cardTitle} numberOfLines={1}>
        {collection.smart ? '⚙ ' : ''}
        {collection.title}
      </Text>
      <Text style={styles.cardArtist} numberOfLines={1}>
        {collection.count} {collection.count === 1 ? 'album' : 'albums'}
      </Text>
    </View>
  );
});

// The on-screen keyboard, memoised.
//
// Typing changes the query and therefore the results, but it does NOT move the
// key cursor — you press OK on the same key repeatedly. Left inline, every
// character still re-rendered all 38 Focusables, each of which drives a spring
// animation, on the JS thread in the same tick as the press. That was most of
// what made typing feel behind the remote.
//
// Props are deliberately three primitives rather than an object, so the memo
// compares by value and a new object literal per render cannot defeat it.
const SearchKeyboard = React.memo(function SearchKeyboard({
  row,
  col,
  active,
}: {
  row: number;
  col: number;
  active: boolean;
}) {
  return (
    <View style={styles.keyboard}>
      {KEY_ROWS.map((keys, ri) => (
        <View key={ri} style={styles.kbRow}>
          {keys.map((key, ci) => {
            const f = active && row === ri && col === ci;
            return (
              <Focusable
                key={ci}
                focused={f}
                scale={1.14}
                ringColor={theme.accentFallback}
                style={
                  key.act
                    ? styles.keyWideBox
                    : key.n
                    ? (styles.keyNarrow as ViewStyle)
                    : (styles.key as ViewStyle)
                }>
                <Text style={[styles.keyText, f && styles.keyTextFocused]}>
                  {key.l}
                </Text>
              </Focusable>
            );
          })}
        </View>
      ))}
    </View>
  );
});

// Memoised playlist cell — the fourth grid of the same geometry. Playlists used
// to be the one library tab that was a vertical list of rows, which made it
// read as a settings screen sitting between three grids of art. Plex builds a
// composite mosaic for a playlist exactly as it does for a collection, so the
// art was already there and unused.
const PlaylistCard = React.memo(function PlaylistCard({
  playlist,
  focused,
}: {
  playlist: PlexPlaylist;
  focused: boolean;
}) {
  const capped = playlist.count > PLAYLIST_MAX;
  return (
    <View style={[styles.card, focused && styles.cardFocused]}>
      {playlist.thumb ? (
        <Image
          source={{uri: artUrl(playlist.thumb, 320)}}
          style={styles.cardArt}
        />
      ) : (
        <View style={[styles.cardArt, styles.cardArtPlaceholder]}>
          <Text style={styles.cardArtPlaceholderText}>
            {(playlist.title || '?').charAt(0).toUpperCase()}
          </Text>
        </View>
      )}
      <View style={styles.cardTitleRow}>
        {/* A smart playlist is a saved query, not a hand-made list, and that
            difference decides whether its contents will have changed since
            last time — so it survives the move to a grid. It is an Icon and
            not the ⚙ character: Fire OS draws that from Noto Color Emoji,
            which is what made the old list's titles fail to line up. */}
        <Icon
          name={playlist.smart ? 'settings' : 'playlists'}
          size={12}
          color={focused ? theme.accentFallback : theme.textDim}
        />
        <Text style={styles.cardTitleFlex} numberOfLines={1}>
          {playlist.title}
        </Text>
      </View>
      <Text style={styles.cardArtist} numberOfLines={1}>
        {playlist.count ? `${playlist.count} tracks` : 'empty'}
        {capped ? ` · first ${PLAYLIST_MAX}` : ''}
      </Text>
    </View>
  );
});

export default function BrowseScreen({navigation, route}: any) {
  const selectedDevice = useDeviceStore(s => s.selectedDevice);
  // Optionally deep-linked to a specific tab (e.g. the Now Playing "Recently
  // Added" button opens Browse directly on the Recent tab).
  // A deep link naming a disabled tab falls back to Albums rather than landing
  // on a tab the bar has no entry for (which would strand the tab cursor).
  const requestedTab: string = route?.params?.initialTab || 'albums';
  const initialTab: string =
    TABS.indexOf(requestedTab) === -1 ? 'albums' : requestedTab;
  const [activeTab, setActiveTab] = useState(initialTab);
  // The landing page. Browse used to open straight onto the album grid, which
  // meant the first thing on screen was ~3.1s of "Loading albums…" — measured
  // on device, and paid on EVERY open, because the app fully exits whenever it
  // is backgrounded. The landing page needs no data at all, so Browse paints
  // and accepts input immediately while every tab warms behind it.
  //
  // A deep link (the Now Playing "Recently Added" button) skips it: that press
  // already named a destination, so showing a chooser would just be in the way.
  // The overlay's search bar deep-links here with the keyboard already up.
  const openSearch: boolean = !!route?.params?.openSearch;
  const [showLanding, setShowLandingState] = useState(
    !route?.params?.initialTab,
  );
  const showLandingRef = useRef(!route?.params?.initialTab);
  // Cursor over the chooser cards. Starts on Albums because that was the tab
  // Browse used to open on, so the default destination is unchanged.
  const [chooserIdx, setChooserIdxState] = useState(
    Math.max(0, TABS.indexOf('albums')),
  );
  const chooserIdxRef = useRef(Math.max(0, TABS.indexOf('albums')));
  // The landing is now two things stacked: a search bar, and below it either
  // the section tiles or the search body (keyboard + results). `landingMode`
  // says which of the two is under the bar; `landingFocus` says whether the
  // cursor is on the bar or in whatever is below it.
  const [landingMode, setLandingModeState] = useState<'tiles' | 'search'>(
    openSearch ? 'search' : 'tiles',
  );
  const landingModeRef = useRef<'tiles' | 'search'>(
    openSearch ? 'search' : 'tiles',
  );
  const setLandingMode = (m: 'tiles' | 'search') => {
    landingModeRef.current = m;
    setLandingModeState(m);
  };
  // Search is ACTIVE when the landing is showing its keyboard and results.
  // The key and row focus flags hang off this rather than off `zone`, which is
  // 'landing' here — reading `zone === 'content'` is what left the keyboard
  // navigating an invisible cursor.
  const searchActive = showLanding && landingMode === 'search';
  const setChooserIdx = (i: number) => {
    chooserIdxRef.current = i;
    setChooserIdxState(i);
  };
  const setShowLanding = (v: boolean) => {
    showLandingRef.current = v;
    setShowLandingState(v);
  };
  const [presets, setPresets] = useState<any[]>([]);
  const [inputSources, setInputSources] = useState<any[]>([]);
  const [, setClient] = useState<WiiMClient | null>(null);

  // Album grid state. `albums` is a bounded RANDOM SAMPLE (ALBUM_SAMPLE), not
  // the whole library — one Plex request instead of paging ~4.5k albums.
  const [albums, setAlbums] = useState<PlexAlbum[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(true);
  const [progress, setProgress] = useState({loaded: 0, total: 0});
  const [statusMsg, setStatusMsg] = useState('');

  // The COMPLETE catalog, loaded lazily. Artists and Search need every album to
  // be correct, so they pull this on first open rather than making the Albums
  // grid wait for it. Kept separate from `albums` so neither truncates.
  const [catalog, setCatalog] = useState<PlexAlbum[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  // Separate from libraryLoading: the artist roster is derived AFTER the
  // catalog lands, and Search must not sit behind work only Artists uses.
  const [artistsLoading, setArtistsLoading] = useState(false);
  const libraryRequested = useRef(false);

  // Recently added grid state (its own light query, not the full catalog).
  const [recentAlbums, setRecentAlbums] = useState<PlexAlbum[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  // Within the Recent tab, focus is either on the Shuffle header button or on
  // the album grid below it.
  const [recentZone, setRecentZoneState] = useState<'shuffle' | 'grid'>('grid');

  // Playlists tab state (vertical list of audio playlists).
  const [playlists, setPlaylists] = useState<PlexPlaylist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(true);

  // Collections tab state: a grid of the library's album collections that
  // drills into one collection's albums, mirroring the Artists tab.
  const [collections, setCollections] = useState<PlexCollection[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  const [collectionView, setCollectionView] = useState<'grid' | 'albums'>(
    'grid',
  );
  const [collectionAlbums, setCollectionAlbums] = useState<PlexAlbum[]>([]);
  const [collectionAlbumsLoading, setCollectionAlbumsLoading] = useState(false);
  const [selectedCollection, setSelectedCollection] =
    useState<PlexCollection | null>(null);

  // Artists tab state: a shuffled grid of all artists (allArtists) that drills
  // into one artist's releases (artistAlbums) on select.
  const [allArtists, setAllArtists] = useState<PlexArtist[]>([]);
  const [artistView, setArtistView] = useState<'grid' | 'albums'>('grid');
  const [artistAlbums, setArtistAlbums] = useState<PlexAlbum[]>([]);
  const [selectedArtist, setSelectedArtist] = useState<PlexArtist | null>(null);
  const [kbPos, setKbPos] = useState({row: 0, col: 0});

  // Album search state (the Search tab — title/artist substring over the cached
  // catalog). Mirrors the artist-search keyboard+results machinery; reuses the
  // shared on-screen keyboard cursor (kbPos), with its own results index/list.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchZone, setSearchZoneState] = useState<'keyboard' | 'results'>(
    'keyboard',
  );
  const [searchResIdx, setSearchResIdxState] = useState(0);

  // Focus cursor
  // With the landing page up there is no content to point at, so focus starts
  // on the tab bar and the very first press already means something.
  const [zone, setZoneState] = useState<Zone>(
    route?.params?.initialTab ? 'content' : 'landing',
  );
  const [index, setIndex] = useState(0);
  const listRef = useRef<FlatList<PlexAlbum>>(null);
  const recentListRef = useRef<FlatList<PlexAlbum>>(null);
  const artistListRef = useRef<FlatList<PlexAlbum>>(null);
  const rosterListRef = useRef<FlatList<PlexArtist>>(null);
  const collectionListRef = useRef<FlatList<PlexCollection>>(null);
  const collectionAlbumListRef = useRef<FlatList<PlexAlbum>>(null);
  const topRowRef = useRef(0); // first grid row currently scrolled into view
  const busyRef = useRef(false);
  // The D-pad listener is registered once and captures first-render closures,
  // where `client` is still null. Read the live client through a ref instead.
  const clientRef = useRef<WiiMClient | null>(null);

  // Refs mirrored for the key handler (registered once, reads live values).
  const zoneRef = useRef<Zone>(
    route?.params?.initialTab ? 'content' : 'landing',
  );
  const idxRef = useRef(0);
  const tabRef = useRef(initialTab);
  const albumsRef = useRef<PlexAlbum[]>([]);
  const recentAlbumsRef = useRef<PlexAlbum[]>([]);
  const recentZoneRef = useRef<'shuffle' | 'grid'>('grid');
  const playlistsRef = useRef<PlexPlaylist[]>([]);
  const playlistListRef = useRef<FlatList<PlexPlaylist>>(null);
  const presetsRef = useRef<any[]>([]);
  const inputsRef = useRef<any[]>([]);
  const artistViewRef = useRef<'grid' | 'albums'>('grid');
  const collectionsRef = useRef<PlexCollection[]>([]);
  const collectionViewRef = useRef<'grid' | 'albums'>('grid');
  const collectionAlbumsRef = useRef<PlexAlbum[]>([]);
  const collectionIdxRef = useRef(0); // grid cursor saved when drilling in
  const kbPosRef = useRef({row: 0, col: 0});
  const allArtistsRef = useRef<PlexArtist[]>([]);
  const rosterIdxRef = useRef(0); // roster cursor saved when drilling into an artist
  const artistAlbumsRef = useRef<PlexAlbum[]>([]);
  // Search-tab mirrors (handler is registered once → read live values via refs).
  const searchZoneRef = useRef<'keyboard' | 'results'>('keyboard');
  const searchResIdxRef = useRef(0);
  const filteredSearchRef = useRef<PlexAlbum[]>([]);
  const searchResTopRef = useRef(0);
  const searchResultsListRef = useRef<FlatList<PlexAlbum>>(null);
  useEffect(() => {
    idxRef.current = index;
  }, [index]);
  useEffect(() => {
    tabRef.current = activeTab;
  }, [activeTab]);
  useEffect(() => {
    albumsRef.current = albums;
  }, [albums]);
  useEffect(() => {
    recentAlbumsRef.current = recentAlbums;
  }, [recentAlbums]);
  useEffect(() => {
    playlistsRef.current = playlists;
  }, [playlists]);
  useEffect(() => {
    presetsRef.current = presets;
  }, [presets]);
  useEffect(() => {
    inputsRef.current = inputSources;
  }, [inputSources]);
  useEffect(() => {
    artistViewRef.current = artistView;
  }, [artistView]);
  useEffect(() => {
    artistAlbumsRef.current = artistAlbums;
  }, [artistAlbums]);
  useEffect(() => {
    collectionsRef.current = collections;
  }, [collections]);
  useEffect(() => {
    collectionViewRef.current = collectionView;
  }, [collectionView]);
  useEffect(() => {
    collectionAlbumsRef.current = collectionAlbums;
  }, [collectionAlbums]);

  // Mirror the shuffled artist roster into a ref for the once-registered D-pad
  // handler (which reads live values without waiting for a re-render).
  useEffect(() => {
    allArtistsRef.current = allArtists;
  }, [allArtists]);

  // Live-filtered album results: match album title OR artist (case-insensitive
  // substring). Empty query shows the whole catalog. Pure in-memory over the
  // lazily-loaded full `catalog` — NOT the 500-album grid sample, so searching
  // still reaches every album in the library. No extra Plex calls.
  // One lowercased "title\nartist" haystack per album, built once when the
  // catalog lands. Without it every keystroke re-lowercased both fields of all
  // ~5.6k albums — over 11k throwaway strings per key press on Hermes.
  // Folded once per catalog load, not per keystroke: this is ~4.5k strings and
  // the query changes on every press.
  const searchIndex = useMemo(
    () => catalog.map(a => fold(`${a.title}\n${a.artist}`)),
    [catalog],
  );
  // The previous query and the catalog positions it matched, so that adding a
  // character narrows that set instead of rescanning ~5.7k strings.
  //
  // This is sound because matching is a plain substring test: if a query gains
  // a character at the end, anything that matches the longer query also matched
  // the shorter one, so the new result set is always a SUBSET of the old. It
  // only applies when the new query extends the old one — deleting a character
  // widens the set, and falls back to a full scan.
  //
  // Keyed on the searchIndex identity so a catalog reload cannot be answered
  // from positions that referred to the previous one.
  const narrowRef = useRef<{src: string[]; q: string; idx: number[]} | null>(
    null,
  );
  const filteredSearch = useMemo(() => {
    const q = fold(searchQuery.trim());
    if (!q) {
      narrowRef.current = null;
      return catalog;
    }
    const prev = narrowRef.current;
    const idx: number[] = [];
    if (prev && prev.src === searchIndex && q.startsWith(prev.q)) {
      for (let n = 0; n < prev.idx.length; n++) {
        const i = prev.idx[n];
        if (searchIndex[i].indexOf(q) !== -1) {
          idx.push(i);
        }
      }
    } else {
      for (let i = 0; i < searchIndex.length; i++) {
        if (searchIndex[i].indexOf(q) !== -1) {
          idx.push(i);
        }
      }
    }
    narrowRef.current = {src: searchIndex, q, idx};
    const out: PlexAlbum[] = [];
    for (let n = 0; n < idx.length; n++) {
      out.push(catalog[idx[n]]);
    }
    return out;
  }, [catalog, searchIndex, searchQuery]);
  useEffect(() => {
    filteredSearchRef.current = filteredSearch;
  }, [filteredSearch]);

  // Small state+ref setters so the once-registered handler always sees fresh
  // values without waiting for a re-render.
  const setKb = (row: number, col: number) => {
    kbPosRef.current = {row, col};
    setKbPos({row, col});
  };

  // Zone changes must reach the ref SYNCHRONOUSLY. onNav reads zoneRef at the
  // top of every press to decide whether the key means "move the grid cursor"
  // or "switch tabs". zoneRef used to be synced in an effect, which runs after
  // React commits — so a press arriving right after 'left' still saw
  // zone === 'content' and was routed to the grid instead of the tab bar.
  //
  // That is the "cannot change tabs while the tab is loading" symptom: while a
  // tab's load occupies the JS thread the commit is late, the window widens,
  // and presses meant for the tab bar silently move the album cursor instead.
  // Measured before this change: four 'right' presses from Albums landed on
  // Collections, not Search — one press misrouted.
  // Debounced per-tab loading. Cleared on unmount so a switch made just before
  // leaving Browse cannot fire into an unmounted screen.
  const tabLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const TAB_LOAD_DELAY = 250;

  const loadForTab = (t: string) => {
    // Artists needs the full catalog; so does the search bar, which is warmed
    // on mount rather than by a tab.
    if (t === 'artists') {
      loadLibrary();
    } else if (t === 'recent') {
      loadRecent();
    } else if (t === 'playlists') {
      loadPlaylists();
    } else if (t === 'collections') {
      loadCollections();
    }
  };

  // No argument on purpose: switchTab has already written tabRef, and by the
  // time this fires more presses may have moved on. The ref is the truth.
  const scheduleTabLoad = () => {
    if (tabLoadTimerRef.current) {
      clearTimeout(tabLoadTimerRef.current);
    }
    tabLoadTimerRef.current = setTimeout(() => {
      tabLoadTimerRef.current = null;
      loadForTab(tabRef.current);
    }, TAB_LOAD_DELAY);
  };

  useEffect(
    () => () => {
      if (tabLoadTimerRef.current) {
        clearTimeout(tabLoadTimerRef.current);
      }
    },
    [],
  );

  const setZone = (z: Zone) => {
    zoneRef.current = z;
    setZoneState(z);
  };

  // Leave the current section and go back to the chooser.
  //
  // Every one of these call sites used to be backToChooser() — walking off the
  // left or top edge of a grid put you on the tab bar. There is no tab bar any
  // more, so the same gesture lands on the chooser instead: the edge still
  // means "out of here", which is the part that was worth keeping.
  const backToChooser = () => {
    setShowLanding(true);
    setZone('landing');
  };

  const setRecentZone = (z: 'shuffle' | 'grid') => {
    recentZoneRef.current = z;
    setRecentZoneState(z);
  };

  const setSearchZone = (z: 'keyboard' | 'results') => {
    searchZoneRef.current = z;
    setSearchZoneState(z);
  };
  const setSearchRes = (i: number) => {
    searchResIdxRef.current = i;
    setSearchResIdxState(i);
    const top = scrollTopFor(i, searchResTopRef.current, RES_VISIBLE);
    if (top !== searchResTopRef.current) {
      searchResTopRef.current = top;
      searchResultsListRef.current?.scrollToOffset({
        offset: top * RESULT_H,
        animated: true,
      });
    }
  };

  useEffect(() => {
    if (!selectedDevice) {
      navigation.navigate('Discovery');
      return;
    }
    const wiimClient = new WiiMClient(selectedDevice.ip);
    setClient(wiimClient);
    clientRef.current = wiimClient;
    loadData(wiimClient);
    // Load order is deliberate, and it is about what is ON SCREEN.
    //
    // The album grid goes first and alone: it is the landing tab, and nothing
    // else should compete with painting it. Firing the other four loads
    // alongside it (as this once did) put ~150 KB of extra JSON parsing and
    // four re-renders of this whole screen in front of the first paint.
    //
    // Everything else is warmed AFTER that paint, sequentially so each await
    // yields the JS thread rather than parsing back to back. Warming matters:
    // with these loading only on first entry to their tab, every tab visited
    // in the first seconds showed a spinner instead of content, which is the
    // "changing tabs is laggy" complaint. The small ones come first because
    // they are cheap and finish quickly; the full catalog is last because it
    // is by far the heaviest and only Artists and Search need it.
    // Nothing here is on the critical path any more — the landing page is
    // already on screen and taking input — so every tab is warmed up front,
    // sequentially so each await yields the JS thread rather than parsing back
    // to back. Whichever tab he picks should already have its data.
    (async () => {
      await loadAlbums();
      await loadRecent();
      await loadPlaylists();
      await loadCollections();
      loadLibrary();
    })();
    // Runs when the selected device changes. navigation is stable and listing it
    // would re-run the whole Plex load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice]);

  // Not cached: playlists are edited outside the app, so reopening Browse
  // should reflect edits. One small request, unlike the album catalog.
  const loadPlaylists = async () => {
    // Spinner only when there is nothing to show. These now run on every entry
    // to their tab, and blanking a list that is already rendered to re-fetch
    // the same thing reads as a slower app, not a fresher one.
    setPlaylistsLoading(playlistsRef.current.length === 0);
    try {
      const list = await getPlaylists();
      setPlaylists(list);
      playlistsRef.current = list;
    } catch (e) {
      // non-fatal; the Playlists tab just shows its empty state
    } finally {
      setPlaylistsLoading(false);
    }
  };

  // Like playlists: one small request, not cached, so collections edited on the
  // server are current every time Browse opens. The albums INSIDE a collection
  // are the expensive part, and those are fetched on drill-in (and cached).
  const loadCollections = async () => {
    setCollectionsLoading(collectionsRef.current.length === 0);
    try {
      const list = await getCollections();
      setCollections(list);
      collectionsRef.current = list;
    } catch (e) {
      // non-fatal; the Collections tab just shows its empty state
    } finally {
      setCollectionsLoading(false);
    }
  };

  const loadRecent = async () => {
    setRecentLoading(recentAlbumsRef.current.length === 0);
    try {
      const list = await getRecentlyAddedAlbums(100);
      setRecentAlbums(list);
      recentAlbumsRef.current = list;
    } catch (e) {
      // non-fatal; the Recent tab just shows its empty state
    } finally {
      setRecentLoading(false);
    }
  };

  // Populates the two WiiM device tabs. Each query is skipped when its tab is
  // disabled, so a Browse open with both off costs the WiiM nothing at all.
  const loadData = async (wiimClient: WiiMClient) => {
    if (!inputsEnabled() && !presetsEnabled()) {
      return;
    }
    try {
      if (inputsEnabled()) {
        const info = await wiimClient.getDeviceInfo();
        if (info.input) {
          setInputSources(Array.isArray(info.input) ? info.input : []);
        }
      }
      if (presetsEnabled()) {
        const presetInfo = await wiimClient.getPresetInfo();
        if (presetInfo) {
          setPresets(Array.isArray(presetInfo) ? presetInfo : []);
        }
      }
    } catch (error) {
      // non-fatal
    }
  };

  const loadAlbums = async () => {
    setAlbumsLoading(true);
    setStatusMsg('');
    try {
      // A single sorted request — the grid no longer waits on the catalog.
      // Order (random vs alphabetical) is RANDOM_ORDER in config/display.ts.
      const list = await getAlbumSample();
      setAlbums(list);
      if (!list.length) {
        setStatusMsg('No albums found on Plex.');
      }
    } catch (e: any) {
      setStatusMsg('Could not load albums: ' + (e?.message || 'error'));
    } finally {
      setAlbumsLoading(false);
    }
  };

  // Artists and Search are the two tabs that genuinely need every album, so
  // they share one lazy load of the full catalog on first open. getShuffledArtists()
  // derives from the same in-api cache, so this stays a single fetch, not two.
  const loadLibrary = async () => {
    if (libraryRequested.current) {
      return;
    }
    libraryRequested.current = true;
    setLibraryLoading(true);
    setArtistsLoading(true);
    setProgress({loaded: 0, total: 0});
    try {
      const all = await loadAllAlbums((loaded, total) =>
        setProgress({loaded, total}),
      );
      setCatalog(all);
      // Search is complete the moment the catalog exists — drop its spinner
      // before deriving the roster, which is pure CPU over the same albums.
      setLibraryLoading(false);
      setAllArtists(await getShuffledArtists());
    } catch (e: any) {
      setStatusMsg('Could not load library: ' + (e?.message || 'error'));
      libraryRequested.current = false; // let the next tab entry retry
    } finally {
      setLibraryLoading(false);
      setArtistsLoading(false);
    }
  };

  const currentItems = (): any[] => {
    const t = tabRef.current;
    if (t === 'albums') {
      return albumsRef.current;
    }
    if (t === 'recent') {
      return recentAlbumsRef.current;
    }
    if (t === 'playlists') {
      return playlistsRef.current;
    }
    if (t === 'presets') {
      return presetsRef.current;
    }
    return inputsRef.current;
  };

  // Whether the album grid is the active scrollable (albums/recent tab, or an
  // artist's releases). Picks which FlatList ref to drive.
  const albumGridRef = () =>
    tabRef.current === 'albums'
      ? listRef
      : tabRef.current === 'recent'
      ? recentListRef
      : tabRef.current === 'playlists'
      ? playlistListRef
      : tabRef.current === 'collections'
      ? collectionViewRef.current === 'albums'
        ? collectionAlbumListRef
        : collectionListRef
      : artistViewRef.current === 'albums'
      ? artistListRef
      : rosterListRef;
  // The Artists and Collections tabs are always grids (the roster/collection
  // list, or the albums under one of them), so both use the album-grid
  // row-stepping scroll.
  const isAlbumGridActive = () =>
    tabRef.current === 'albums' ||
    tabRef.current === 'recent' ||
    tabRef.current === 'artists' ||
    tabRef.current === 'playlists' ||
    tabRef.current === 'collections';

  const moveTo = (i: number) => {
    setIndex(i);
    idxRef.current = i;
    if (!isAlbumGridActive()) {
      return;
    }
    // Scroll only when the focused row leaves the visible window, and only by
    // whole rows — horizontal moves within a row never scroll. This keeps
    // browsing smooth instead of re-centering on every keypress.
    const newRow = Math.floor(i / COLS);
    const top = scrollTopFor(newRow, topRowRef.current, VISIBLE_ROWS);
    if (top !== topRowRef.current) {
      topRowRef.current = top;
      albumGridRef().current?.scrollToOffset({
        offset: top * ROW_H,
        animated: true,
      });
    }
  };

  const handlePlayAlbum = async (album: PlexAlbum) => {
    const c = clientRef.current;
    if (!c || busyRef.current) {
      return;
    }
    busyRef.current = true;
    setStatusMsg(`Loading "${album.title}"…`);
    try {
      const queue = await buildAlbumQueue(album);
      if (!queue.length) {
        setStatusMsg(`No playable tracks in "${album.title}"`);
        return;
      }
      // Playing a finite album supersedes any active station auto-refill.
      usePlayerStore.getState().setPlayerState({stationKind: null});
      await c.playAlbumQueue(queue, 0);
      navigation.navigate('NowPlaying');
    } catch (e: any) {
      setStatusMsg(`Failed to play "${album.title}": ${e?.message || 'error'}`);
    } finally {
      busyRef.current = false;
    }
  };

  // Random play across the recently added music: build a shuffled queue and go.
  const handleShuffleRecent = async () => {
    const c = clientRef.current;
    if (!c || busyRef.current) {
      return;
    }
    busyRef.current = true;
    setStatusMsg('Shuffling recent additions…');
    try {
      const queue = await buildRecentQueue(60);
      if (!queue.length) {
        setStatusMsg('No recent tracks to shuffle');
        return;
      }
      // A shuffle queue supersedes any active station auto-refill.
      usePlayerStore.getState().setPlayerState({stationKind: null});
      await c.playAlbumQueue(queue, 0);
      navigation.navigate('NowPlaying');
    } catch (e: any) {
      setStatusMsg(`Shuffle failed: ${e?.message || 'error'}`);
    } finally {
      busyRef.current = false;
    }
  };

  // Play a Plex playlist in its stored order. Large smart playlists are capped
  // at PLAYLIST_MAX tracks (see buildPlaylistQueue) — the status line says so,
  // otherwise a 30k-track playlist looks like it silently truncated.
  const handlePlayPlaylist = async (pl: PlexPlaylist) => {
    const c = clientRef.current;
    if (!c || busyRef.current) {
      return;
    }
    if (!pl.count) {
      setStatusMsg(`"${pl.title}" is empty`);
      return;
    }
    busyRef.current = true;
    setStatusMsg(`Loading "${pl.title}"…`);
    try {
      const queue = await buildPlaylistQueue(pl.ratingKey);
      if (!queue.length) {
        setStatusMsg(`No playable tracks in "${pl.title}"`);
        return;
      }
      // A playlist is a finite queue, so it supersedes station auto-refill.
      usePlayerStore.getState().setPlayerState({stationKind: null});
      await c.playAlbumQueue(queue, 0);
      navigation.navigate('NowPlaying');
    } catch (e: any) {
      setStatusMsg(`Failed to play "${pl.title}": ${e?.message || 'error'}`);
    } finally {
      busyRef.current = false;
    }
  };

  // On-screen keyboard input for the album Search tab (its own query/results).
  const applySearchKey = (key: Key) => {
    setSearchQuery(q => {
      let nq = q;
      if (key.act === 'space') {
        nq = q + ' ';
      } else if (key.act === 'del') {
        nq = q.slice(0, -1);
      } else if (key.act === 'clear') {
        nq = '';
      } else {
        nq = q + key.v;
      }
      return nq.slice(0, 40);
    });
    searchResIdxRef.current = 0;
    setSearchResIdxState(0);
    searchResTopRef.current = 0;
    searchResultsListRef.current?.scrollToOffset({offset: 0, animated: false});
  };

  const openArtist = (a: PlexArtist) => {
    const list = getAlbumsByArtist(a.key);
    setSelectedArtist(a);
    setArtistAlbums(list);
    artistAlbumsRef.current = list;
    // Remember the roster cursor so backing out lands on the same artist card.
    rosterIdxRef.current = idxRef.current;
    setArtistView('albums');
    artistViewRef.current = 'albums';
    setIndex(0);
    idxRef.current = 0;
    topRowRef.current = 0;
    artistListRef.current?.scrollToOffset({offset: 0, animated: false});
  };

  // Drill into a collection. Unlike openArtist (which slices the already-loaded
  // catalog synchronously) this is a network fetch — the biggest collections
  // here run past a thousand albums — so the grid switches immediately and the
  // albums land under a spinner.
  const openCollection = async (c: PlexCollection) => {
    setSelectedCollection(c);
    // Remember the grid cursor so backing out lands on the same collection.
    collectionIdxRef.current = idxRef.current;
    setCollectionAlbums([]);
    collectionAlbumsRef.current = [];
    setCollectionView('albums');
    collectionViewRef.current = 'albums';
    setIndex(0);
    idxRef.current = 0;
    topRowRef.current = 0;
    collectionAlbumListRef.current?.scrollToOffset({
      offset: 0,
      animated: false,
    });
    setCollectionAlbumsLoading(true);
    try {
      const list = await getCollectionAlbums(c.ratingKey);
      setCollectionAlbums(list);
      collectionAlbumsRef.current = list;
    } catch (e: any) {
      setStatusMsg(`Could not load "${c.title}": ${e?.message || 'error'}`);
    } finally {
      setCollectionAlbumsLoading(false);
    }
  };

  const backToCollections = () => {
    setCollectionView('grid');
    collectionViewRef.current = 'grid';
    // Restore the grid cursor saved when we drilled into this collection.
    const i = collectionIdxRef.current;
    setIndex(i);
    idxRef.current = i;
    const top = scrollTopFor(Math.floor(i / COLS), 0, VISIBLE_ROWS);
    topRowRef.current = top;
    collectionListRef.current?.scrollToOffset({
      offset: top * ROW_H,
      animated: false,
    });
  };

  const backToRoster = () => {
    setArtistView('grid');
    artistViewRef.current = 'grid';
    // Restore the roster cursor saved when we drilled into this artist.
    const i = rosterIdxRef.current;
    setIndex(i);
    idxRef.current = i;
    const top = scrollTopFor(Math.floor(i / COLS), 0, VISIBLE_ROWS);
    topRowRef.current = top;
    rosterListRef.current?.scrollToOffset({
      offset: top * ROW_H,
      animated: false,
    });
  };

  const activateContent = (i: number) => {
    const t = tabRef.current;
    const items = currentItems();
    if (!items[i]) {
      return;
    }
    if (t === 'albums' || t === 'recent') {
      handlePlayAlbum(items[i]);
    } else if (t === 'playlists') {
      handlePlayPlaylist(items[i]);
    } else if (t === 'presets') {
      clientRef.current?.loadPreset(i).catch(() => {});
    } else {
      clientRef.current?.switchInput(items[i]).catch(() => {});
    }
  };

  // --- D-pad handler (JS-managed focus) -------------------------------------
  const onNavArtists = (k: string) => {
    // Grid view: the shuffled roster of all artists, navigated like the album
    // grid. Select drills into that artist's releases.
    if (artistViewRef.current === 'grid') {
      const items = allArtistsRef.current;
      const n = items.length;
      const idx = idxRef.current;
      const col = idx % COLS;
      const row = Math.floor(idx / COLS);
      if (k === 'left') {
        if (col > 0) {
          moveTo(idx - 1);
        } else {
          backToChooser();
        }
      } else if (k === 'right') {
        if (col < COLS - 1 && idx + 1 < n) {
          moveTo(idx + 1);
        }
      } else if (k === 'up') {
        if (row > 0) {
          moveTo(idx - COLS);
        } else {
          backToChooser();
        }
      } else if (k === 'down') {
        if (idx + COLS < n) {
          moveTo(idx + COLS);
        } else {
          setZone('back');
        }
      } else if (k === 'select') {
        if (items[idx]) {
          openArtist(items[idx]);
        }
      }
      return;
    }

    // artistView === 'albums' — the selected artist's releases. Leaving the grid
    // from its top row or left edge returns to the roster.
    const items = artistAlbumsRef.current;
    const n = items.length;
    const idx = idxRef.current;
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    if (k === 'left') {
      if (col > 0) {
        moveTo(idx - 1);
      } else {
        backToRoster();
      }
    } else if (k === 'right') {
      if (col < COLS - 1 && idx + 1 < n) {
        moveTo(idx + 1);
      }
    } else if (k === 'up') {
      if (row > 0) {
        moveTo(idx - COLS);
      } else {
        backToRoster();
      }
    } else if (k === 'down') {
      if (idx + COLS < n) {
        moveTo(idx + COLS);
      } else {
        setZone('back');
      }
    } else if (k === 'select') {
      if (items[idx]) {
        handlePlayAlbum(items[idx]);
      }
    }
  };

  // Collections tab: a grid of collections that drills into one collection's
  // albums. Same shape as onNavArtists — leaving the album grid from its top
  // row or left edge returns to the collection grid.
  const onNavCollections = (k: string) => {
    const inAlbums = collectionViewRef.current === 'albums';
    const items: any[] = inAlbums
      ? collectionAlbumsRef.current
      : collectionsRef.current;
    const n = items.length;
    const idx = idxRef.current;
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);

    if (k === 'left') {
      if (col > 0) {
        moveTo(idx - 1);
      } else if (inAlbums) {
        backToCollections();
      } else {
        backToChooser();
      }
    } else if (k === 'right') {
      if (col < COLS - 1 && idx + 1 < n) {
        moveTo(idx + 1);
      }
    } else if (k === 'up') {
      if (row > 0) {
        moveTo(idx - COLS);
      } else if (inAlbums) {
        backToCollections();
      } else {
        backToChooser();
      }
    } else if (k === 'down') {
      if (idx + COLS < n) {
        moveTo(idx + COLS);
      } else {
        setZone('back');
      }
    } else if (k === 'select') {
      if (items[idx]) {
        if (inAlbums) {
          handlePlayAlbum(items[idx]);
        } else {
          openCollection(items[idx]);
        }
      }
    }
  };

  // Search tab: shared on-screen keyboard (left) + album results list (right).
  const onNavSearch = (k: string) => {
    const sz = searchZoneRef.current;

    if (sz === 'keyboard') {
      const nav = navKeyboard(KEY_ROWS, kbPosRef.current, k);
      if (nav.kind === 'move') {
        setKb(nav.pos.row, nav.pos.col);
      } else if (nav.kind === 'press') {
        applySearchKey(nav.key);
      } else if (nav.kind === 'exitLeft' || nav.kind === 'exitUp') {
        // Nothing to the left of or above the keyboard: the query bar is a
        // readout, not a control, and BACK is the way out.
      } else if (nav.kind === 'exitDown') {
        // Nothing below the keyboard on this screen; BACK is the way out.
      } else if (nav.kind === 'exitRight') {
        // Only cross into the results column when there is something there.
        if (filteredSearchRef.current.length) {
          setSearchZone('results');
        }
      }
      return;
    }

    // sz === 'results' — matching albums; select plays the album.
    const list = filteredSearchRef.current;
    const n = list.length;
    const ri = searchResIdxRef.current;
    if (k === 'up') {
      if (ri > 0) {
        setSearchRes(ri - 1);
      }
    } else if (k === 'down') {
      if (ri < n - 1) {
        setSearchRes(ri + 1);
      }
    } else if (k === 'left') {
      setSearchZone('keyboard');
    } else if (k === 'select') {
      if (list[ri]) {
        handlePlayAlbum(list[ri]);
      }
    }
  };

  // Recent tab: a Shuffle header button above the album grid.
  const onNavRecent = (k: string) => {
    const items = recentAlbumsRef.current;
    const n = items.length;
    if (recentZoneRef.current === 'shuffle') {
      if (k === 'up' || k === 'left') {
        backToChooser();
      } else if (k === 'down') {
        if (n) {
          setRecentZone('grid');
          moveTo(0);
        }
      } else if (k === 'select') {
        handleShuffleRecent();
      }
      return;
    }
    // grid
    const idx = idxRef.current;
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    if (k === 'left') {
      if (col > 0) {
        moveTo(idx - 1);
      } else {
        backToChooser();
      }
    } else if (k === 'right') {
      if (col < COLS - 1 && idx + 1 < n) {
        moveTo(idx + 1);
      }
    } else if (k === 'up') {
      if (row > 0) {
        moveTo(idx - COLS);
      } else {
        setRecentZone('shuffle');
      } // top row → up lands on Shuffle
    } else if (k === 'down') {
      if (idx + COLS < n) {
        moveTo(idx + COLS);
      } else {
        setZone('back');
      }
    } else if (k === 'select') {
      if (items[idx]) {
        handlePlayAlbum(items[idx]);
      }
    }
  };

  // The album under the cursor, for whichever view is showing one. Returns null
  // on the tabs/back zones and on the non-album tabs, so MENU does nothing
  // there rather than opening a detail view for something that isn't an album.
  const focusedAlbum = (): PlexAlbum | null => {
    // Search results are on the landing now, not in a content zone, so they
    // need their own branch or MENU would go dead over them.
    if (showLandingRef.current) {
      return landingModeRef.current === 'search' &&
        searchZoneRef.current === 'results'
        ? filteredSearchRef.current[searchResIdxRef.current] || null
        : null;
    }
    if (zoneRef.current !== 'content') {
      return null;
    }
    const t = tabRef.current;
    const i = idxRef.current;
    if (t === 'albums') {
      return albumsRef.current[i] || null;
    }
    if (t === 'recent') {
      return recentZoneRef.current === 'grid'
        ? recentAlbumsRef.current[i] || null
        : null;
    }
    if (t === 'artists') {
      // Only the releases view holds albums; the roster holds artists, so MENU
      // (track listing) does nothing on the roster.
      return artistViewRef.current === 'albums'
        ? artistAlbumsRef.current[i] || null
        : null;
    }
    if (t === 'collections') {
      // Only the drilled-in view holds albums; the collection grid does not.
      return collectionViewRef.current === 'albums'
        ? collectionAlbumsRef.current[i] || null
        : null;
    }
    return null;
  };

  const onNav = (k: string) => {
    const z = zoneRef.current;

    // MENU (☰) opens the album track listing. Deliberately not OK — playing an
    // album outright is the common case and stays one keypress.
    if (k === 'menu') {
      const a = focusedAlbum();
      if (a) {
        navigation.navigate('Album', {album: a});
      }
      return;
    }

    if (z === 'landing') {
      const openTab = (nextTab: string) => {
        setShowLanding(false);
        setActiveTab(nextTab);
        tabRef.current = nextTab;
        // Load the tab you SETTLE on, not every tab you pass through.
        //
        // This used to fire the tab's loader inline, on the keypress. Walking
        // the bar therefore started a Plex request, a JSON parse and a large
        // setState for every tab crossed — on the JS thread, in the same tick
        // as the press. While that ran, the next press could not be serviced,
        // which is exactly "you cannot change tabs while that tab is loading".
        // Passing through four tabs paid for four loads to reach one.
        //
        // Deferring by a beat costs nothing when you stop on a tab and saves
        // all of it when you are travelling. loadLibrary/loadRecent and friends
        // are individually idempotent, so a settled tab that is already loaded
        // still does nothing.
        scheduleTabLoad();
        setIndex(0);
        idxRef.current = 0;
        topRowRef.current = 0;
        // Always land the Artists tab back on its shuffled roster grid.
        setArtistView('grid');
        artistViewRef.current = 'grid';
        // Same for Collections: re-enter on the collection grid, not inside
        // whichever collection was open last.
        setCollectionView('grid');
        collectionViewRef.current = 'grid';
        collectionIdxRef.current = 0;
        collectionListRef.current?.scrollToOffset({
          offset: 0,
          animated: false,
        });
        // Search tab always re-enters on the keyboard, results at the top.
        setSearchZone('keyboard');
        searchResIdxRef.current = 0;
        setSearchResIdxState(0);
        searchResTopRef.current = 0;
        // Recent tab lands on the album grid (Shuffle is one Up away).
        setRecentZone('grid');
        // Playlists re-enter at the top of the grid. topRowRef is reset
        // above with the other grids; this only rewinds the list itself.
        playlistListRef.current?.scrollToOffset({offset: 0, animated: false});
      };
      // The landing is showing the search keyboard and results.
      if (landingModeRef.current === 'search') {
        onNavSearch(k);
        return;
      }

      // The landing is showing the section tiles.
      // 2D cursor over the card grid. Clamped rather than wrapped: on a remote
      // a wrap reads as the cursor jumping somewhere you did not ask for.
      const i = chooserIdxRef.current;
      const n = TABS.length;
      const col = i % CHOOSER_COLS;
      if (k === 'left') {
        if (col > 0) {
          setChooserIdx(i - 1);
        }
      } else if (k === 'right') {
        if (col < CHOOSER_COLS - 1 && i + 1 < n) {
          setChooserIdx(i + 1);
        }
      } else if (k === 'up') {
        if (i - CHOOSER_COLS >= 0) {
          setChooserIdx(i - CHOOSER_COLS);
        }
      } else if (k === 'down') {
        if (i + CHOOSER_COLS < n) {
          setChooserIdx(i + CHOOSER_COLS);
        } else if (i < n - 1) {
          // Short last row: fall to its end rather than dead-stopping.
          setChooserIdx(n - 1);
        }
      } else if (k === 'select') {
        openTab(TABS[i]);
        setShowLanding(false);
        setZone('content');
      }
      return;
    }

    if (z === 'back') {
      if (k === 'up') {
        setZone('content');
      } else if (k === 'select') {
        navigation.navigate('NowPlaying');
      }
      return;
    }

    // z === 'content'
    if (tabRef.current === 'artists') {
      onNavArtists(k);
      return;
    }
    if (tabRef.current === 'collections') {
      onNavCollections(k);
      return;
    }
    if (tabRef.current === 'search') {
      onNavSearch(k);
      return;
    }
    if (tabRef.current === 'recent') {
      onNavRecent(k);
      return;
    }

    const items = currentItems();
    const n = items.length;
    const idx = idxRef.current;

    if (tabRef.current === 'albums' || tabRef.current === 'playlists') {
      const col = idx % COLS;
      const row = Math.floor(idx / COLS);
      if (k === 'left') {
        if (col > 0) {
          moveTo(idx - 1);
        } else {
          backToChooser();
        }
      } else if (k === 'right') {
        if (col < COLS - 1 && idx + 1 < n) {
          moveTo(idx + 1);
        }
      } else if (k === 'up') {
        if (row > 0) {
          moveTo(idx - COLS);
        } else {
          backToChooser();
        }
      } else if (k === 'down') {
        if (idx + COLS < n) {
          moveTo(idx + COLS);
        } else {
          setZone('back');
        }
      } else if (k === 'select') {
        activateContent(idx);
      }
    } else {
      // vertical list (presets / inputs)
      if (k === 'up') {
        if (idx > 0) {
          moveTo(idx - 1);
        } else {
          backToChooser();
        }
      } else if (k === 'down') {
        if (idx + 1 < n) {
          moveTo(idx + 1);
        } else {
          setZone('back');
        }
      } else if (k === 'left') {
        backToChooser();
      } else if (k === 'select') {
        activateContent(idx);
      }
    }
  };

  // Capture the D-pad while focused (consistent with NowPlayingScreen).
  useFocusEffect(
    useCallback(() => {
      captureDpad();
      const unsub = subscribeNav(onNav);

      // BACK is a level, not an exit. Inside a section it returns to the
      // chooser; only from the chooser itself does it leave for Now Playing,
      // by falling through to react-navigation.
      //
      // BACK never reaches onNav — MainActivity only maps the D-pad, select and
      // menu into WiiMNavKey — so this has to be its own handler.
      const backSub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (!showLandingRef.current) {
          backToChooser();
          return true;
        }
        // On the landing, BACK first closes the search body and returns to the
        // section tiles; only from the tiles does it leave Browse.
        if (landingModeRef.current === 'search') {
          setLandingMode('tiles');
          return true;
        }
        return false;
      });

      return () => {
        unsub();
        backSub.remove();
      };
      // The D-pad listener is registered ONCE; onNav is re-created each render
      // and listing it would tear down and re-add the listener continuously.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const albumGrid = (
    data: PlexAlbum[],
    gridRef: React.RefObject<FlatList<PlexAlbum>>,
    keyStr: string,
    focusedIdx: number,
  ) => (
    <FlatList
      key={keyStr}
      ref={gridRef}
      data={data}
      renderItem={({item, index: i}) => (
        <AlbumCard album={item} focused={focusedIdx === i} />
      )}
      keyExtractor={item => item.ratingKey}
      extraData={focusedIdx}
      numColumns={COLS}
      columnWrapperStyle={styles.row}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      initialNumToRender={20}
      windowSize={7}
      getItemLayout={(_data, i) => ({
        // FlatList with numColumns feeds whole rows to the virtualizer, so `i`
        // here is the ROW index — pitch is exactly ROW_H per row.
        length: ROW_H,
        offset: LIST_TOP + ROW_H * i,
        index: i,
      })}
    />
  );

  const renderListItem = ({index: i, label}: any) => {
    const focused = zone === 'content' && index === i;
    return (
      <View style={[styles.item, focused && styles.itemFocused]}>
        <Text style={styles.itemText}>{label}</Text>
      </View>
    );
  };

  // Playlists: a grid of composite mosaics, laid out exactly like Collections
  // and Artists. See PlaylistCard for why this stopped being a list.
  const renderPlaylistsTab = () => (
    <FlatList
      key="playlists-grid"
      ref={playlistListRef}
      data={playlists}
      renderItem={({item, index: i}) => (
        <PlaylistCard
          playlist={item}
          focused={zone === 'content' && index === i}
        />
      )}
      keyExtractor={item => item.ratingKey}
      extraData={zone === 'content' ? index : -1}
      numColumns={COLS}
      columnWrapperStyle={styles.row}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      initialNumToRender={20}
      windowSize={7}
      getItemLayout={(_data, i) => ({
        length: ROW_H,
        offset: LIST_TOP + ROW_H * i,
        index: i,
      })}
      ListEmptyComponent={
        <Text style={styles.noResults}>No audio playlists on Plex.</Text>
      }
    />
  );

  const renderArtistsTab = () => {
    if (artistView === 'albums') {
      return (
        <View style={styles.artistAlbumsWrap}>
          <Text style={styles.artistHeader} numberOfLines={1}>
            {selectedArtist?.name} · {artistAlbums.length}{' '}
            {artistAlbums.length === 1 ? 'release' : 'releases'}
          </Text>
          {albumGrid(
            artistAlbums,
            artistListRef,
            'artist-albums-grid',
            zone === 'content' ? index : -1,
          )}
        </View>
      );
    }
    // Grid view: the shuffled roster of every artist, laid out like Albums.
    return (
      <FlatList
        key="artist-roster-grid"
        ref={rosterListRef}
        data={allArtists}
        renderItem={({item, index: i}) => (
          <ArtistCard
            artist={item}
            focused={zone === 'content' && index === i}
          />
        )}
        keyExtractor={item => item.key}
        extraData={zone === 'content' ? index : -1}
        numColumns={COLS}
        columnWrapperStyle={styles.row}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        initialNumToRender={20}
        windowSize={7}
        getItemLayout={(_data, i) => ({
          length: ROW_H,
          offset: LIST_TOP + ROW_H * i,
          index: i,
        })}
        ListEmptyComponent={
          <Text style={styles.noResults}>No artists found.</Text>
        }
      />
    );
  };

  const renderCollectionsTab = () => {
    if (collectionView === 'albums') {
      return (
        <View style={styles.artistAlbumsWrap}>
          <Text style={styles.artistHeader} numberOfLines={1}>
            {selectedCollection?.title}
            {collectionAlbumsLoading
              ? ' · loading…'
              : ` · ${collectionAlbums.length} ${
                  collectionAlbums.length === 1 ? 'album' : 'albums'
                }`}
          </Text>
          {collectionAlbumsLoading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color="#3b9eff" />
            </View>
          ) : (
            albumGrid(
              collectionAlbums,
              collectionAlbumListRef,
              'collection-albums-grid',
              zone === 'content' ? index : -1,
            )
          )}
        </View>
      );
    }
    return (
      <FlatList
        key="collections-grid"
        ref={collectionListRef}
        data={collections}
        renderItem={({item, index: i}) => (
          <CollectionCard
            collection={item}
            focused={zone === 'content' && index === i}
          />
        )}
        keyExtractor={item => item.ratingKey}
        extraData={zone === 'content' ? index : -1}
        numColumns={COLS}
        columnWrapperStyle={styles.row}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        initialNumToRender={20}
        windowSize={7}
        getItemLayout={(_data, i) => ({
          length: ROW_H,
          offset: LIST_TOP + ROW_H * i,
          index: i,
        })}
        ListEmptyComponent={
          <Text style={styles.noResults}>No album collections on Plex.</Text>
        }
      />
    );
  };

  // The search body: keyboard on the left, results on the right. The query bar
  // is NOT here — it is the landing's own bar, which stays on screen whether
  // this body or the section tiles is showing.
  const renderSearchBody = () => (
    <View style={styles.searchWrap}>
      <View style={styles.searchRow}>
        <SearchKeyboard
          row={kbPos.row}
          col={kbPos.col}
          active={searchActive && searchZone === 'keyboard'}
        />
        <FlatList
          key="search-results"
          ref={searchResultsListRef}
          data={filteredSearch}
          renderItem={({item, index: i}) => {
            const f =
              searchActive && searchZone === 'results' && searchResIdx === i;
            return (
              <Focusable
                focused={f}
                scale={1.02}
                ringColor={theme.accentFallback}
                style={styles.resultItem}>
                <Text style={styles.resultName} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={styles.resultCount} numberOfLines={1}>
                  {item.artist}
                </Text>
              </Focusable>
            );
          }}
          keyExtractor={item => item.ratingKey}
          extraData={`${searchZone}:${searchResIdx}`}
          style={styles.resultsList}
          contentContainerStyle={styles.listContent}
          getItemLayout={(_d, i) => ({
            length: RESULT_H,
            offset: LIST_TOP + RESULT_H * i,
            index: i,
          })}
          ListEmptyComponent={
            <Text style={styles.noResults}>
              {libraryLoading ? 'Loading library…' : 'No matching albums'}
            </Text>
          }
        />
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      {!!statusMsg && <Text style={styles.statusMsg}>{statusMsg}</Text>}

      {showLanding ? (
        <View style={styles.landing}>
          {/* The query bar belongs to the search body, not to the chooser —
              the way IN to search is the bar on the Now Playing overlay. This
              one exists to show what has been typed so far. */}
          {landingMode === 'search' ? (
            <View style={styles.searchBar}>
              <Icon name="search" size={22} color={theme.textDim} />
              <Text
                style={searchQuery ? styles.queryText : styles.queryPlaceholder}
                numberOfLines={1}>
                {searchQuery || 'Search albums & artists…'}
                <Text style={styles.caret}>▏</Text>
              </Text>
              {searchQuery ? (
                <Text style={styles.matchCount}>
                  {filteredSearch.length}{' '}
                  {filteredSearch.length === 1 ? 'match' : 'matches'}
                </Text>
              ) : null}
            </View>
          ) : null}
          {landingMode === 'search' ? (
            renderSearchBody()
          ) : (
            <View style={styles.chooserGrid}>
              {Array.from(
                {length: Math.ceil(TABS.length / CHOOSER_COLS)},
                (_, r) => TABS.slice(r * CHOOSER_COLS, (r + 1) * CHOOSER_COLS),
              ).map((row, r) => (
                <View key={r} style={styles.chooserRow}>
                  {row.map((id, c) => {
                    const i = r * CHOOSER_COLS + c;
                    const on = chooserIdx === i;
                    return (
                      <Focusable
                        key={id}
                        focused={on}
                        scale={1.06}
                        ringColor={theme.accentFallback}
                        style={styles.chooserCard}>
                        <Icon
                          name={TAB_ICONS[id]}
                          size={34}
                          color={on ? theme.accentFallback : theme.textPrimary}
                        />
                        <Text style={styles.chooserLabel}>
                          {TAB_LABELS[id]}
                        </Text>
                      </Focusable>
                    );
                  })}
                </View>
              ))}
            </View>
          )}
        </View>
      ) : activeTab === 'albums' ? (
        albumsLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#3b9eff" />
            {/* One request now, so there is no page progress to report. */}
            <Text style={styles.loadingText}>Loading albums…</Text>
          </View>
        ) : (
          albumGrid(
            albums,
            listRef,
            'albums-grid',
            zone === 'content' ? index : -1,
          )
        )
      ) : activeTab === 'recent' ? (
        recentLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#3b9eff" />
            <Text style={styles.loadingText}>Loading recent additions…</Text>
          </View>
        ) : recentAlbums.length ? (
          <View style={styles.recentWrap}>
            <Focusable
              focused={zone === 'content' && recentZone === 'shuffle'}
              scale={1.06}
              ringColor={theme.accentFallback}
              style={styles.shuffleBtn}>
              <Icon
                name="shuffle"
                size={22}
                color={
                  zone === 'content' && recentZone === 'shuffle'
                    ? theme.accentFallback
                    : theme.textPrimary
                }
              />
              <Text style={styles.shuffleText}>Shuffle</Text>
            </Focusable>
            {albumGrid(
              recentAlbums,
              recentListRef,
              'recent-grid',
              zone === 'content' && recentZone === 'grid' ? index : -1,
            )}
          </View>
        ) : (
          <View style={styles.loadingBox}>
            <Text style={styles.loadingText}>No recently added albums.</Text>
          </View>
        )
      ) : activeTab === 'playlists' ? (
        playlistsLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#3b9eff" />
            <Text style={styles.loadingText}>Loading playlists…</Text>
          </View>
        ) : (
          renderPlaylistsTab()
        )
      ) : activeTab === 'collections' ? (
        collectionsLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#3b9eff" />
            <Text style={styles.loadingText}>Loading collections…</Text>
          </View>
        ) : (
          renderCollectionsTab()
        )
      ) : activeTab === 'artists' ? (
        libraryLoading || artistsLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#3b9eff" />
            <Text style={styles.loadingText}>
              Loading library{' '}
              {progress.total ? `${progress.loaded} / ${progress.total}` : '…'}
            </Text>
          </View>
        ) : (
          renderArtistsTab()
        )
      ) : activeTab === 'presets' ? (
        <FlatList
          key="presets-list"
          data={presets}
          renderItem={({item, index: i}) =>
            renderListItem({
              item,
              index: i,
              label: item?.title || `Preset ${i + 1}`,
            })
          }
          keyExtractor={(_, i) => `preset-${i}`}
          style={styles.list}
          contentContainerStyle={styles.listContent}
        />
      ) : (
        <FlatList
          key="inputs-list"
          data={inputSources}
          renderItem={({item, index: i}) =>
            renderListItem({item, index: i, label: item})
          }
          keyExtractor={item => String(item)}
          style={styles.list}
          contentContainerStyle={styles.listContent}
        />
      )}

      {/* MENU is invisible without a prompt, so say so on the tabs that
          actually show albums. The artist roster is its own case: OK opens the
          artist rather than playing, and MENU does nothing there. */}
      {showLanding ? (
        landingMode === 'search' ? (
          <Text style={styles.menuHint}>
            OK: play album · ☰ Menu: track listing
          </Text>
        ) : null
      ) : activeTab === 'artists' && artistView === 'grid' ? (
        <Text style={styles.menuHint}>OK: view artist</Text>
      ) : activeTab === 'collections' && collectionView === 'grid' ? (
        <Text style={styles.menuHint}>OK: view collection</Text>
      ) : activeTab === 'albums' ||
        activeTab === 'recent' ||
        (activeTab === 'artists' && artistView === 'albums') ||
        (activeTab === 'collections' && collectionView === 'albums') ? (
        <Text style={styles.menuHint}>
          OK: play album · ☰ Menu: track listing
        </Text>
      ) : null}

      <Focusable
        focused={zone === 'back'}
        scale={1.08}
        style={styles.backButton}>
        <Text
          style={[
            styles.backButtonText,
            zone === 'back' && styles.backFocusedText,
          ]}>
          ← Back
        </Text>
      </Focusable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    paddingHorizontal: H_PAD,
    paddingVertical: 20,
  },
  menuHint: {
    color: '#5b6472',
    fontSize: 12,
    textAlign: 'center',
    marginBottom: 6,
  },
  statusMsg: {
    color: '#3b9eff',
    fontSize: 13,
    marginLeft: 12,
    flexShrink: 1,
  },
  list: {
    flex: 1,
  },
  // The reserve that FOCUS_PAD and LIST_TOP set aside, actually spent. CARD_W
  // is computed net of the horizontal half, so the row still fits.
  listContent: {
    paddingTop: LIST_TOP,
    paddingHorizontal: FOCUS_PAD,
  },
  row: {
    gap: GAP,
    marginBottom: GAP,
  },
  card: {
    width: CARD_W,
    height: CARD_H,
    borderRadius: 10,
    padding: CARD_PAD,
    borderWidth: CARD_BORDER,
    borderColor: 'transparent',
    backgroundColor: '#222',
  },
  cardFocused: {
    borderColor: '#ffffff',
    backgroundColor: '#16315a',
    transform: [{scale: 1.07}],
  },
  cardArt: {
    width: '100%',
    height: ART_H,
    borderRadius: 6,
    backgroundColor: '#111',
  },
  cardArtPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardArtPlaceholderText: {
    fontSize: 48,
    color: '#3b9eff',
    fontWeight: 'bold',
  },
  cardTitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 6,
  },
  cardArtist: {
    color: '#9aa',
    fontSize: 12,
  },
  // Playlist cards put a glyph before the title, so the title line is a row.
  // The icon is a sibling of the text rather than a prefix character inside it
  // — that is what keeps the titles aligned with each other down a column.
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 6,
  },
  cardTitleFlex: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  // The landing body. Deliberately plain: it exists to be instant, so it holds
  // nothing that needs fetching, measuring or decoding beyond one small bundled
  // PNG.
  // The section chooser. Still called "landing" because it occupies the same
  // slot, and that slot exists for a performance reason worth preserving:
  // opening straight onto the album grid meant ~3.1s of "Loading albums…" on
  // EVERY open, because the app fully exits when backgrounded. This paints and
  // accepts input immediately while the tabs warm behind it.
  //
  // The photo that used to fill it is gone with the tab bar it depended on: the
  // bar did the choosing and the photo was only something to look at while you
  // chose. Now the cards do both.
  // The landing stacks the search bar over the body. It no longer centres a
  // single block: the bar is pinned at the top so it does not move when the
  // body under it swaps between the tiles and the keyboard.
  landing: {
    flex: 1,
  },
  // The bar reads as an input without shouting — a faint surface and a
  // hairline, the same treatment the old query bar carried.
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: radius.md,
    paddingHorizontal: 18,
    paddingVertical: 12,
    marginBottom: space.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  // The match count is metadata about the query, so it recedes and sits at the
  // far end of the bar. flex on the text before it keeps this pinned right.
  matchCount: {
    ...typeScale.caption,
    color: theme.textDim,
  },
  chooserGrid: {
    flex: 1,
    justifyContent: 'center',
    gap: space.md,
  },
  chooserRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.md,
  },
  chooserCard: {
    width: 220,
    height: 116,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  chooserLabel: {
    ...typeScale.label,
    color: theme.textPrimary,
  },
  loadingBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    color: '#aaa',
    fontSize: 16,
  },
  item: {
    backgroundColor: '#2a2a2a',
    paddingHorizontal: 20,
    paddingVertical: 15,
    marginBottom: 10,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#3b9eff',
    borderWidth: 3,
    borderColor: 'transparent',
  },
  itemFocused: {
    borderColor: '#ffffff',
    backgroundColor: '#16315a',
  },
  itemText: {
    color: '#fff',
    fontSize: 16,
  },
  // --- artist search --------------------------------------------------------
  searchWrap: {
    flex: 1,
  },
  queryText: {
    ...typeScale.title,
    color: theme.textPrimary,
    flex: 1,
  },
  queryPlaceholder: {
    ...typeScale.title,
    fontWeight: '400',
    color: theme.textDim,
    flex: 1,
  },
  caret: {
    color: '#3b9eff',
  },
  searchRow: {
    flex: 1,
    flexDirection: 'row',
    gap: 24,
  },
  keyboard: {
    gap: 8,
  },
  kbRow: {
    flexDirection: 'row',
    gap: 8,
  },
  // Ten digits against seven letters: 10x38 + 9x8 gaps is 452dp, against the
  // letter rows' 7x54 + 6x8 = 426dp. Close enough that the block still reads
  // as one keyboard rather than a wider row bolted underneath.
  keyNarrow: {
    width: 38,
    height: 50,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  key: {
    width: 54,
    height: 50,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyWideBox: {
    width: 78,
    height: 50,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyText: {
    ...typeScale.body,
    color: theme.textSecondary,
    fontWeight: 'bold',
  },
  // Focused keys tint rather than invert. The old key filled solid blue with
  // near-black text, which at typing speed strobed the whole keyboard.
  keyTextFocused: {
    color: theme.accentFallback,
  },
  resultsList: {
    flex: 1,
  },
  // List rows for the Search results column — the last list view left, now
  // that Playlists is a grid.
  //
  // These were the last of the old focus idiom: a 3dp white border snapping on
  // over a #16315a fill, which made every row read as a form field. Now the row
  // sits on the same faint surface as every other control and focus is carried
  // by the accent ring and brightness, as it is everywhere else.
  resultItem: {
    height: RESULT_H - 8,
    marginBottom: 8,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: radius.md,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  // flex, not flexShrink. The row is space-between, so letting the title take
  // the free space pins it left and pushes the count to the edge instead of
  // leaving the title floating in the middle.
  resultName: {
    ...typeScale.body,
    color: theme.textPrimary,
    flex: 1,
  },
  // The secondary column — track counts, artist names. A count is metadata
  // about the row, not a second title, so it recedes.
  resultCount: {
    ...typeScale.caption,
    color: theme.textDim,
  },
  noResults: {
    color: '#777',
    fontSize: 16,
    padding: 20,
  },
  recentWrap: {
    flex: 1,
  },
  // Shuffle, as a control rather than a slab. It used to be a solid violet pill
  // with an emoji die in it — the loudest object on a screen of album art, and
  // the emoji was drawn by Noto Color Emoji so it could never be tinted to
  // match anything. The concept was right; the presentation was doing too much.
  shuffleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.sm,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginBottom: 14,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  shuffleText: {
    ...typeScale.label,
    color: theme.textPrimary,
  },
  artistAlbumsWrap: {
    flex: 1,
  },
  artistHeader: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  // Plain "← Back", not a filled bar.
  //
  // It used to be a full-width solid blue slab with dark text — the loudest
  // thing on a screen whose whole content is album art, and it read as a
  // web page's submit button.
  //
  // Since it now sits on whatever colour happens to be behind it, legibility
  // cannot come from a fill: it comes from white text plus the same shadow the
  // Now Playing hero uses over album art. That combination holds on a white
  // sleeve and on a black one, which a fill of any single colour would not.
  backButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 4,
    paddingVertical: 8,
    marginTop: 12,
  },
  backButtonText: {
    ...typeScale.label,
    color: theme.textPrimary,
    ...onArt,
  },
  // Focused: tint to the accent and brighten. No border, no fill — the same
  // language as every other focusable thing in the app now.
  backFocusedText: {
    color: theme.accentFallback,
  },
});
