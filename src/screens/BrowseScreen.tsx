import React, {useCallback, useState, useEffect, useRef, useMemo} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  Dimensions,
  ActivityIndicator,
  DeviceEventEmitter,
  NativeModules,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {useDeviceStore} from '../store/deviceStore';
import {WiiMClient} from '../api/wiim';
import {
  getShuffledAlbums,
  getArtists,
  getAlbumsByArtist,
  getRecentlyAddedAlbums,
  buildRecentQueue,
  buildAlbumQueue,
  getPlaylists,
  buildPlaylistQueue,
  PLAYLIST_MAX,
  artUrl,
  PlexAlbum,
  PlexArtist,
  PlexPlaylist,
} from '../api/plex';
import {usePlayerStore} from '../store/playerStore';

const {width: SCREEN_W, height: SCREEN_H} = Dimensions.get('window');
const COLS = 5;
const H_PAD = 40; // container horizontal padding
const GAP = 16;
const CARD_W = Math.floor((SCREEN_W - H_PAD * 2 - GAP * (COLS - 1)) / COLS);

// Fixed card geometry so row heights are deterministic — required for exact
// getItemLayout and smooth, row-stepped scrolling.
const CARD_PAD = 6;
const CARD_BORDER = 3;
const ART_H = CARD_W - 2 * (CARD_PAD + CARD_BORDER); // square cover
const CAPTION_H = 42; // title + artist (fixed)
const CARD_H = 2 * CARD_BORDER + 2 * CARD_PAD + ART_H + CAPTION_H;
const ROW_H = CARD_H + GAP; // vertical pitch between rows

// Roughly how many album rows fit in the list viewport (used to decide when a
// move needs to scroll). Subtracts the tab bar / back button / paddings.
const LIST_H = SCREEN_H - 40 - 66 - 64;
const VISIBLE_ROWS = Math.max(1, Math.floor(LIST_H / ROW_H));

// Artist results list geometry (fixed for exact getItemLayout / windowing).
const RESULT_H = 60;
const RES_VISIBLE = Math.max(1, Math.floor(LIST_H / RESULT_H));

// Playlist rows are the same pitch as artist results so they reuse RES_VISIBLE.
const PLAYLIST_H = RESULT_H;

const TABS = [
  'albums',
  'recent',
  'playlists',
  'artists',
  'search',
  'presets',
  'inputs',
];
const TAB_LABELS: Record<string, string> = {
  albums: 'Albums',
  recent: 'Recent',
  playlists: 'Playlists',
  artists: 'Artists',
  search: 'Search',
  presets: 'Presets',
  inputs: 'Inputs',
};

// On-screen keyboard layout. Letter rows are 7 wide; the last row holds the
// action keys (space / delete / clear). Column is clamped to row width when
// moving vertically between rows of different lengths.
type Key = {l: string; v: string; act?: 'space' | 'del' | 'clear'};
const letterRow = (s: string): Key[] => s.split('').map((c) => ({l: c, v: c}));
const KEY_ROWS: Key[][] = [
  letterRow('ABCDEFG'),
  letterRow('HIJKLMN'),
  letterRow('OPQRSTU'),
  letterRow('VWXYZ'),
  [
    {l: 'SPACE', v: ' ', act: 'space'},
    {l: 'DEL', v: '', act: 'del'},
    {l: 'CLEAR', v: '', act: 'clear'},
  ],
];

// Focus zones for the JS-managed D-pad cursor (this app captures the D-pad and
// drives focus in JS rather than relying on native TV focus). 'content' is
// further split for the Artists tab via artistZone (keyboard/results/albumgrid).
type Zone = 'tabs' | 'content' | 'back';
type ArtistZone = 'keyboard' | 'results' | 'albumgrid';

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
        <Image source={{uri: artUrl(album.thumb, 320)}} style={styles.cardArt} />
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

export default function BrowseScreen({navigation, route}: any) {
  const selectedDevice = useDeviceStore((s) => s.selectedDevice);
  // Optionally deep-linked to a specific tab (e.g. the Now Playing "Recently
  // Added" button opens Browse directly on the Recent tab).
  const initialTab: string = route?.params?.initialTab || 'albums';
  const [activeTab, setActiveTab] = useState(initialTab);
  const [presets, setPresets] = useState<any[]>([]);
  const [inputSources, setInputSources] = useState<any[]>([]);
  const [client, setClient] = useState<WiiMClient | null>(null);

  // Album grid state
  const [albums, setAlbums] = useState<PlexAlbum[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(true);
  const [progress, setProgress] = useState({loaded: 0, total: 0});
  const [statusMsg, setStatusMsg] = useState('');

  // Recently added grid state (its own light query, not the full catalog).
  const [recentAlbums, setRecentAlbums] = useState<PlexAlbum[]>([]);
  const [recentLoading, setRecentLoading] = useState(true);
  // Within the Recent tab, focus is either on the Shuffle header button or on
  // the album grid below it.
  const [recentZone, setRecentZoneState] = useState<'shuffle' | 'grid'>('grid');

  // Playlists tab state (vertical list of audio playlists).
  const [playlists, setPlaylists] = useState<PlexPlaylist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(true);

  // Artist search state
  const [allArtists, setAllArtists] = useState<PlexArtist[]>([]);
  const [artistQuery, setArtistQuery] = useState('');
  const [artistView, setArtistView] = useState<'search' | 'albums'>('search');
  const [artistAlbums, setArtistAlbums] = useState<PlexAlbum[]>([]);
  const [selectedArtist, setSelectedArtist] = useState<PlexArtist | null>(null);
  const [artistZone, setArtistZoneState] = useState<ArtistZone>('keyboard');
  const [kbPos, setKbPos] = useState({row: 0, col: 0});
  const [resIdx, setResIdxState] = useState(0);

  // Album search state (the Search tab — title/artist substring over the cached
  // catalog). Mirrors the artist-search keyboard+results machinery; reuses the
  // shared on-screen keyboard cursor (kbPos), with its own results index/list.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchZone, setSearchZoneState] = useState<'keyboard' | 'results'>(
    'keyboard',
  );
  const [searchResIdx, setSearchResIdxState] = useState(0);

  // Focus cursor
  const [zone, setZone] = useState<Zone>('content');
  const [index, setIndex] = useState(0);
  const listRef = useRef<FlatList<PlexAlbum>>(null);
  const recentListRef = useRef<FlatList<PlexAlbum>>(null);
  const artistListRef = useRef<FlatList<PlexAlbum>>(null);
  const resultsListRef = useRef<FlatList<PlexArtist>>(null);
  const topRowRef = useRef(0); // first album row currently scrolled into view
  const resTopRef = useRef(0); // first result row currently scrolled into view
  const busyRef = useRef(false);
  // The D-pad listener is registered once and captures first-render closures,
  // where `client` is still null. Read the live client through a ref instead.
  const clientRef = useRef<WiiMClient | null>(null);

  // Refs mirrored for the key handler (registered once, reads live values).
  const zoneRef = useRef<Zone>('content');
  const idxRef = useRef(0);
  const tabRef = useRef(initialTab);
  const albumsRef = useRef<PlexAlbum[]>([]);
  const recentAlbumsRef = useRef<PlexAlbum[]>([]);
  const recentZoneRef = useRef<'shuffle' | 'grid'>('grid');
  const playlistsRef = useRef<PlexPlaylist[]>([]);
  const playlistListRef = useRef<FlatList<PlexPlaylist>>(null);
  const playlistTopRef = useRef(0); // first playlist row scrolled into view
  const presetsRef = useRef<any[]>([]);
  const inputsRef = useRef<any[]>([]);
  const artistViewRef = useRef<'search' | 'albums'>('search');
  const artistZoneRef = useRef<ArtistZone>('keyboard');
  const kbPosRef = useRef({row: 0, col: 0});
  const resIdxRef = useRef(0);
  const filteredArtistsRef = useRef<PlexArtist[]>([]);
  const artistAlbumsRef = useRef<PlexAlbum[]>([]);
  // Search-tab mirrors (handler is registered once → read live values via refs).
  const searchZoneRef = useRef<'keyboard' | 'results'>('keyboard');
  const searchResIdxRef = useRef(0);
  const filteredSearchRef = useRef<PlexAlbum[]>([]);
  const searchResTopRef = useRef(0);
  const searchResultsListRef = useRef<FlatList<PlexAlbum>>(null);
  useEffect(() => {
    zoneRef.current = zone;
  }, [zone]);
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

  // Live-filtered artist results (substring, case-insensitive).
  const filteredArtists = useMemo(() => {
    const q = artistQuery.trim().toLowerCase();
    if (!q) return allArtists;
    return allArtists.filter((a) => a.name.toLowerCase().includes(q));
  }, [allArtists, artistQuery]);
  useEffect(() => {
    filteredArtistsRef.current = filteredArtists;
  }, [filteredArtists]);

  // Live-filtered album results: match album title OR artist (case-insensitive
  // substring). Empty query shows the whole catalog. Pure in-memory over the
  // already-loaded `albums` — no extra Plex calls.
  const filteredSearch = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return albums;
    return albums.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.artist.toLowerCase().includes(q),
    );
  }, [albums, searchQuery]);
  useEffect(() => {
    filteredSearchRef.current = filteredSearch;
  }, [filteredSearch]);

  // Small state+ref setters so the once-registered handler always sees fresh
  // values without waiting for a re-render.
  const setArtistZone = (z: ArtistZone) => {
    artistZoneRef.current = z;
    setArtistZoneState(z);
  };
  const setKb = (row: number, col: number) => {
    kbPosRef.current = {row, col};
    setKbPos({row, col});
  };
  const setRes = (i: number) => {
    resIdxRef.current = i;
    setResIdxState(i);
    let top = resTopRef.current;
    if (i < top) top = i;
    else if (i > top + RES_VISIBLE - 1) top = i - RES_VISIBLE + 1;
    if (top !== resTopRef.current) {
      resTopRef.current = top;
      resultsListRef.current?.scrollToOffset({
        offset: top * RESULT_H,
        animated: true,
      });
    }
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
    let top = searchResTopRef.current;
    if (i < top) top = i;
    else if (i > top + RES_VISIBLE - 1) top = i - RES_VISIBLE + 1;
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
    loadAlbums();
    loadRecent();
    loadPlaylists();
  }, [selectedDevice]);

  // Not cached: playlists are edited outside the app, so reopening Browse
  // should reflect edits. One small request, unlike the album catalog.
  const loadPlaylists = async () => {
    setPlaylistsLoading(true);
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

  const loadRecent = async () => {
    setRecentLoading(true);
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

  const loadData = async (wiimClient: WiiMClient) => {
    try {
      const info = await wiimClient.getDeviceInfo();
      if (info.input) {
        setInputSources(Array.isArray(info.input) ? info.input : []);
      }
      const presetInfo = await wiimClient.getPresetInfo();
      if (presetInfo) {
        setPresets(Array.isArray(presetInfo) ? presetInfo : []);
      }
    } catch (error) {
      // non-fatal
    }
  };

  const loadAlbums = async () => {
    setAlbumsLoading(true);
    setStatusMsg('');
    try {
      const list = await getShuffledAlbums((loaded, total) =>
        setProgress({loaded, total}),
      );
      setAlbums(list);
      if (!list.length) setStatusMsg('No albums found on Plex.');
      // Artists are derived from the same cached catalog (no extra fetch).
      const arts = await getArtists();
      setAllArtists(arts);
    } catch (e: any) {
      setStatusMsg('Could not load albums: ' + (e?.message || 'error'));
    } finally {
      setAlbumsLoading(false);
    }
  };

  const currentItems = (): any[] => {
    const t = tabRef.current;
    if (t === 'albums') return albumsRef.current;
    if (t === 'recent') return recentAlbumsRef.current;
    if (t === 'playlists') return playlistsRef.current;
    if (t === 'presets') return presetsRef.current;
    return inputsRef.current;
  };

  // Whether the album grid is the active scrollable (albums/recent tab, or an
  // artist's releases). Picks which FlatList ref to drive.
  const albumGridRef = () =>
    tabRef.current === 'albums'
      ? listRef
      : tabRef.current === 'recent'
      ? recentListRef
      : artistListRef;
  const isAlbumGridActive = () =>
    tabRef.current === 'albums' ||
    tabRef.current === 'recent' ||
    (tabRef.current === 'artists' && artistViewRef.current === 'albums');

  const moveTo = (i: number) => {
    setIndex(i);
    idxRef.current = i;
    // Playlists are a long vertical list (presets/inputs are short enough that
    // they never scroll), so they need the same keep-focus-visible stepping the
    // album grid gets — just by single rows instead of grid rows.
    if (tabRef.current === 'playlists') {
      let top = playlistTopRef.current;
      if (i < top) top = i;
      else if (i > top + RES_VISIBLE - 1) top = i - RES_VISIBLE + 1;
      if (top !== playlistTopRef.current) {
        playlistTopRef.current = top;
        playlistListRef.current?.scrollToOffset({
          offset: top * PLAYLIST_H,
          animated: true,
        });
      }
      return;
    }
    if (!isAlbumGridActive()) return;
    // Scroll only when the focused row leaves the visible window, and only by
    // whole rows — horizontal moves within a row never scroll. This keeps
    // browsing smooth instead of re-centering on every keypress.
    const newRow = Math.floor(i / COLS);
    let top = topRowRef.current;
    if (newRow < top) {
      top = newRow;
    } else if (newRow > top + VISIBLE_ROWS - 1) {
      top = newRow - VISIBLE_ROWS + 1;
    }
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
    if (!c || busyRef.current) return;
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
    if (!c || busyRef.current) return;
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
    if (!c || busyRef.current) return;
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

  // --- artist search actions ------------------------------------------------
  const applyKey = (key: Key) => {
    // The D-pad listener is registered once, so this closure can't read the
    // live `artistQuery` directly — use the functional updater to append to the
    // current value instead of the stale first-render '' (which made each key
    // replace the last).
    setArtistQuery((q) => {
      let nq = q;
      if (key.act === 'space') nq = q + ' ';
      else if (key.act === 'del') nq = q.slice(0, -1);
      else if (key.act === 'clear') nq = '';
      else nq = q + key.v;
      return nq.slice(0, 40);
    });
    // Query changed → results reset to the top.
    resIdxRef.current = 0;
    setResIdxState(0);
    resTopRef.current = 0;
    resultsListRef.current?.scrollToOffset({offset: 0, animated: false});
  };

  // Same as applyKey but for the album Search tab (its own query/results).
  const applySearchKey = (key: Key) => {
    setSearchQuery((q) => {
      let nq = q;
      if (key.act === 'space') nq = q + ' ';
      else if (key.act === 'del') nq = q.slice(0, -1);
      else if (key.act === 'clear') nq = '';
      else nq = q + key.v;
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
    setArtistView('albums');
    artistViewRef.current = 'albums';
    setArtistZone('albumgrid');
    setIndex(0);
    idxRef.current = 0;
    topRowRef.current = 0;
    artistListRef.current?.scrollToOffset({offset: 0, animated: false});
  };

  const backToSearch = (z: ArtistZone) => {
    setArtistView('search');
    artistViewRef.current = 'search';
    setArtistZone(z);
  };

  const activateContent = (i: number) => {
    const t = tabRef.current;
    const items = currentItems();
    if (!items[i]) return;
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
    const az = artistZoneRef.current;

    if (az === 'keyboard') {
      const kb = kbPosRef.current;
      const row = KEY_ROWS[kb.row];
      if (k === 'left') {
        if (kb.col > 0) setKb(kb.row, kb.col - 1);
        else setZone('tabs');
      } else if (k === 'right') {
        if (kb.col < row.length - 1) setKb(kb.row, kb.col + 1);
        else if (filteredArtistsRef.current.length) setArtistZone('results');
      } else if (k === 'up') {
        if (kb.row > 0) {
          const nr = kb.row - 1;
          setKb(nr, Math.min(kb.col, KEY_ROWS[nr].length - 1));
        } else {
          setZone('tabs');
        }
      } else if (k === 'down') {
        if (kb.row < KEY_ROWS.length - 1) {
          const nr = kb.row + 1;
          setKb(nr, Math.min(kb.col, KEY_ROWS[nr].length - 1));
        } else {
          setZone('back');
        }
      } else if (k === 'select') {
        applyKey(row[kb.col]);
      }
      return;
    }

    if (az === 'results') {
      const list = filteredArtistsRef.current;
      const n = list.length;
      const ri = resIdxRef.current;
      if (k === 'up') {
        if (ri > 0) setRes(ri - 1);
        else setZone('tabs');
      } else if (k === 'down') {
        if (ri < n - 1) setRes(ri + 1);
        else setZone('back');
      } else if (k === 'left') {
        setArtistZone('keyboard');
      } else if (k === 'select') {
        if (list[ri]) openArtist(list[ri]);
      }
      return;
    }

    // az === 'albumgrid' — an artist's releases
    const items = artistAlbumsRef.current;
    const n = items.length;
    const idx = idxRef.current;
    const col = idx % COLS;
    const row = Math.floor(idx / COLS);
    if (k === 'left') {
      if (col > 0) moveTo(idx - 1);
      else backToSearch('results');
    } else if (k === 'right') {
      if (col < COLS - 1 && idx + 1 < n) moveTo(idx + 1);
    } else if (k === 'up') {
      if (row > 0) moveTo(idx - COLS);
      else backToSearch('results');
    } else if (k === 'down') {
      if (idx + COLS < n) moveTo(idx + COLS);
      else setZone('back');
    } else if (k === 'select') {
      if (items[idx]) handlePlayAlbum(items[idx]);
    }
  };

  // Search tab: shared on-screen keyboard (left) + album results list (right).
  const onNavSearch = (k: string) => {
    const sz = searchZoneRef.current;

    if (sz === 'keyboard') {
      const kb = kbPosRef.current;
      const row = KEY_ROWS[kb.row];
      if (k === 'left') {
        if (kb.col > 0) setKb(kb.row, kb.col - 1);
        else setZone('tabs');
      } else if (k === 'right') {
        if (kb.col < row.length - 1) setKb(kb.row, kb.col + 1);
        else if (filteredSearchRef.current.length) setSearchZone('results');
      } else if (k === 'up') {
        if (kb.row > 0) {
          const nr = kb.row - 1;
          setKb(nr, Math.min(kb.col, KEY_ROWS[nr].length - 1));
        } else {
          setZone('tabs');
        }
      } else if (k === 'down') {
        if (kb.row < KEY_ROWS.length - 1) {
          const nr = kb.row + 1;
          setKb(nr, Math.min(kb.col, KEY_ROWS[nr].length - 1));
        } else {
          setZone('back');
        }
      } else if (k === 'select') {
        applySearchKey(row[kb.col]);
      }
      return;
    }

    // sz === 'results' — matching albums; select plays the album.
    const list = filteredSearchRef.current;
    const n = list.length;
    const ri = searchResIdxRef.current;
    if (k === 'up') {
      if (ri > 0) setSearchRes(ri - 1);
      else setZone('tabs');
    } else if (k === 'down') {
      if (ri < n - 1) setSearchRes(ri + 1);
      else setZone('back');
    } else if (k === 'left') {
      setSearchZone('keyboard');
    } else if (k === 'select') {
      if (list[ri]) handlePlayAlbum(list[ri]);
    }
  };

  // Recent tab: a Shuffle header button above the album grid.
  const onNavRecent = (k: string) => {
    const items = recentAlbumsRef.current;
    const n = items.length;
    if (recentZoneRef.current === 'shuffle') {
      if (k === 'up' || k === 'left') {
        setZone('tabs');
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
      if (col > 0) moveTo(idx - 1);
      else setZone('tabs');
    } else if (k === 'right') {
      if (col < COLS - 1 && idx + 1 < n) moveTo(idx + 1);
    } else if (k === 'up') {
      if (row > 0) moveTo(idx - COLS);
      else setRecentZone('shuffle'); // top row → up lands on Shuffle
    } else if (k === 'down') {
      if (idx + COLS < n) moveTo(idx + COLS);
      else setZone('back');
    } else if (k === 'select') {
      if (items[idx]) handlePlayAlbum(items[idx]);
    }
  };

  const onNav = (k: string) => {
    const z = zoneRef.current;

    if (z === 'tabs') {
      const ti = TABS.indexOf(tabRef.current);
      const switchTab = (nextTab: string) => {
        setActiveTab(nextTab);
        tabRef.current = nextTab;
        setIndex(0);
        idxRef.current = 0;
        topRowRef.current = 0;
        // Always land an Artists tab back on its search view.
        setArtistView('search');
        artistViewRef.current = 'search';
        setArtistZone('keyboard');
        // Search tab always re-enters on the keyboard, results at the top.
        setSearchZone('keyboard');
        searchResIdxRef.current = 0;
        setSearchResIdxState(0);
        searchResTopRef.current = 0;
        // Recent tab lands on the album grid (Shuffle is one Up away).
        setRecentZone('grid');
        // Playlists re-enter at the top of the list.
        playlistTopRef.current = 0;
        playlistListRef.current?.scrollToOffset({offset: 0, animated: false});
      };
      if (k === 'left' && ti > 0) {
        switchTab(TABS[ti - 1]);
      } else if (k === 'right' && ti < TABS.length - 1) {
        switchTab(TABS[ti + 1]);
      } else if (k === 'down' || k === 'select') {
        setZone('content');
        if (tabRef.current === 'artists') {
          setArtistZone(
            artistViewRef.current === 'albums' ? 'albumgrid' : 'keyboard',
          );
        } else if (tabRef.current === 'search') {
          setSearchZone('keyboard');
        }
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

    if (tabRef.current === 'albums') {
      const col = idx % COLS;
      const row = Math.floor(idx / COLS);
      if (k === 'left') {
        if (col > 0) moveTo(idx - 1);
        else setZone('tabs');
      } else if (k === 'right') {
        if (col < COLS - 1 && idx + 1 < n) moveTo(idx + 1);
      } else if (k === 'up') {
        if (row > 0) moveTo(idx - COLS);
        else setZone('tabs');
      } else if (k === 'down') {
        if (idx + COLS < n) moveTo(idx + COLS);
        else setZone('back');
      } else if (k === 'select') {
        activateContent(idx);
      }
    } else {
      // vertical list (presets / inputs)
      if (k === 'up') {
        if (idx > 0) moveTo(idx - 1);
        else setZone('tabs');
      } else if (k === 'down') {
        if (idx + 1 < n) moveTo(idx + 1);
        else setZone('back');
      } else if (k === 'left') {
        setZone('tabs');
      } else if (k === 'select') {
        activateContent(idx);
      }
    }
  };

  // Capture the D-pad while focused (consistent with NowPlayingScreen).
  useFocusEffect(
    useCallback(() => {
      NativeModules.RemoteControl?.setCaptureDpad(true);
      const sub = DeviceEventEmitter.addListener('WiiMNavKey', onNav);
      return () => sub.remove();
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
      keyExtractor={(item) => item.ratingKey}
      extraData={focusedIdx}
      numColumns={COLS}
      columnWrapperStyle={styles.row}
      style={styles.list}
      initialNumToRender={20}
      windowSize={7}
      getItemLayout={(_data, i) => ({
        // FlatList with numColumns feeds whole rows to the virtualizer, so `i`
        // here is the ROW index — pitch is exactly ROW_H per row.
        length: ROW_H,
        offset: ROW_H * i,
        index: i,
      })}
    />
  );

  const renderListItem = ({item, index: i, label}: any) => {
    const focused = zone === 'content' && index === i;
    return (
      <View style={[styles.item, focused && styles.itemFocused]}>
        <Text style={styles.itemText}>{label}</Text>
      </View>
    );
  };

  // Playlists: a plain vertical list. Reuses the artist-result row styling so
  // the two list views look like one thing. Track count doubles as the "is this
  // the playlist I meant" cue, since several share a title on this server.
  const renderPlaylistsTab = () => (
    <FlatList
      key="playlists-list"
      ref={playlistListRef}
      data={playlists}
      renderItem={({item, index: i}) => {
        const f = zone === 'content' && index === i;
        const capped = item.count > PLAYLIST_MAX;
        return (
          <View style={[styles.resultItem, f && styles.resultItemFocused]}>
            <Text style={styles.resultName} numberOfLines={1}>
              {item.smart ? '⚙ ' : ''}
              {item.title}
            </Text>
            <Text style={styles.resultCount}>
              {item.count ? `${item.count} tracks` : 'empty'}
              {capped ? ` · first ${PLAYLIST_MAX}` : ''}
            </Text>
          </View>
        );
      }}
      keyExtractor={(item) => item.ratingKey}
      extraData={index}
      style={styles.resultsList}
      getItemLayout={(_d, i) => ({
        length: PLAYLIST_H,
        offset: PLAYLIST_H * i,
        index: i,
      })}
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
            zone === 'content' && artistZone === 'albumgrid' ? index : -1,
          )}
        </View>
      );
    }
    return (
      <View style={styles.searchWrap}>
        <View style={styles.queryBar}>
          <Text
            style={artistQuery ? styles.queryText : styles.queryPlaceholder}
            numberOfLines={1}>
            {artistQuery || 'Type an artist name…'}
            {artistQuery ? <Text style={styles.caret}>▏</Text> : null}
          </Text>
        </View>
        <View style={styles.searchRow}>
          <View style={styles.keyboard}>
            {KEY_ROWS.map((row, ri) => (
              <View key={ri} style={styles.kbRow}>
                {row.map((key, ci) => {
                  const f =
                    zone === 'content' &&
                    artistZone === 'keyboard' &&
                    kbPos.row === ri &&
                    kbPos.col === ci;
                  return (
                    <View
                      key={ci}
                      style={[
                        styles.key,
                        key.act && styles.keyWide,
                        f && styles.keyFocused,
                      ]}>
                      <Text
                        style={[styles.keyText, f && styles.keyTextFocused]}>
                        {key.l}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
          <FlatList
            key="artist-results"
            ref={resultsListRef}
            data={filteredArtists}
            renderItem={({item, index: i}) => {
              const f =
                zone === 'content' && artistZone === 'results' && resIdx === i;
              return (
                <View style={[styles.resultItem, f && styles.resultItemFocused]}>
                  <Text style={styles.resultName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.resultCount}>{item.count}</Text>
                </View>
              );
            }}
            keyExtractor={(item) => item.key}
            extraData={`${artistZone}:${resIdx}`}
            style={styles.resultsList}
            getItemLayout={(_d, i) => ({
              length: RESULT_H,
              offset: RESULT_H * i,
              index: i,
            })}
            ListEmptyComponent={
              <Text style={styles.noResults}>No matching artists</Text>
            }
          />
        </View>
      </View>
    );
  };

  const renderSearchTab = () => (
    <View style={styles.searchWrap}>
      <View style={styles.queryBar}>
        <Text
          style={searchQuery ? styles.queryText : styles.queryPlaceholder}
          numberOfLines={1}>
          {searchQuery || 'Search albums & artists…'}
          {searchQuery ? <Text style={styles.caret}>▏</Text> : null}
        </Text>
      </View>
      <View style={styles.searchRow}>
        <View style={styles.keyboard}>
          {KEY_ROWS.map((row, ri) => (
            <View key={ri} style={styles.kbRow}>
              {row.map((key, ci) => {
                const f =
                  zone === 'content' &&
                  searchZone === 'keyboard' &&
                  kbPos.row === ri &&
                  kbPos.col === ci;
                return (
                  <View
                    key={ci}
                    style={[
                      styles.key,
                      key.act && styles.keyWide,
                      f && styles.keyFocused,
                    ]}>
                    <Text style={[styles.keyText, f && styles.keyTextFocused]}>
                      {key.l}
                    </Text>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
        <FlatList
          key="search-results"
          ref={searchResultsListRef}
          data={filteredSearch}
          renderItem={({item, index: i}) => {
            const f =
              zone === 'content' &&
              searchZone === 'results' &&
              searchResIdx === i;
            return (
              <View style={[styles.resultItem, f && styles.resultItemFocused]}>
                <Text style={styles.resultName} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={styles.resultCount} numberOfLines={1}>
                  {item.artist}
                </Text>
              </View>
            );
          }}
          keyExtractor={(item) => item.ratingKey}
          extraData={`${searchZone}:${searchResIdx}`}
          style={styles.resultsList}
          getItemLayout={(_d, i) => ({
            length: RESULT_H,
            offset: RESULT_H * i,
            index: i,
          })}
          ListEmptyComponent={
            <Text style={styles.noResults}>No matching albums</Text>
          }
        />
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.tabs}>
        {TABS.map((id) => {
          const isActive = activeTab === id;
          const isFocused = zone === 'tabs' && isActive;
          return (
            <View
              key={id}
              style={[
                styles.tab,
                isActive && styles.activeTab,
                isFocused && styles.tabFocused,
              ]}>
              <Text style={[styles.tabText, isActive && styles.activeTabText]}>
                {TAB_LABELS[id]}
              </Text>
            </View>
          );
        })}
        {!!statusMsg && <Text style={styles.statusMsg}>{statusMsg}</Text>}
      </View>

      {activeTab === 'albums' ? (
        albumsLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#3b9eff" />
            <Text style={styles.loadingText}>
              Loading albums{' '}
              {progress.total ? `${progress.loaded} / ${progress.total}` : '…'}
            </Text>
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
            <View
              style={[
                styles.shuffleBtn,
                zone === 'content' &&
                  recentZone === 'shuffle' &&
                  styles.shuffleBtnFocused,
              ]}>
              <Text style={styles.shuffleText}>🎲 Shuffle recently added</Text>
            </View>
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
        ) : playlists.length ? (
          renderPlaylistsTab()
        ) : (
          <View style={styles.loadingBox}>
            <Text style={styles.loadingText}>No audio playlists on Plex.</Text>
          </View>
        )
      ) : activeTab === 'artists' ? (
        albumsLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#3b9eff" />
            <Text style={styles.loadingText}>Loading library…</Text>
          </View>
        ) : (
          renderArtistsTab()
        )
      ) : activeTab === 'search' ? (
        albumsLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#3b9eff" />
            <Text style={styles.loadingText}>Loading library…</Text>
          </View>
        ) : (
          renderSearchTab()
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
        />
      ) : (
        <FlatList
          key="inputs-list"
          data={inputSources}
          renderItem={({item, index: i}) =>
            renderListItem({item, index: i, label: item})
          }
          keyExtractor={(item) => String(item)}
          style={styles.list}
        />
      )}

      <View style={[styles.backButton, zone === 'back' && styles.backFocused]}>
        <Text style={styles.backButtonText}>← Back</Text>
      </View>
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
  tabs: {
    flexDirection: 'row',
    marginBottom: 16,
    gap: 10,
    alignItems: 'center',
  },
  tab: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#333',
    borderRadius: 8,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  activeTab: {
    backgroundColor: '#3b9eff',
  },
  tabFocused: {
    borderColor: '#ffffff',
  },
  tabText: {
    color: '#ddd',
    fontWeight: 'bold',
  },
  activeTabText: {
    color: '#1a1a1a',
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
  queryBar: {
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 12,
    marginBottom: 16,
    borderWidth: 2,
    borderColor: '#3b9eff',
  },
  queryText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '600',
  },
  queryPlaceholder: {
    color: '#777',
    fontSize: 20,
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
  key: {
    width: 54,
    height: 50,
    borderRadius: 8,
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: 'transparent',
  },
  keyWide: {
    width: 78,
  },
  keyFocused: {
    borderColor: '#ffffff',
    backgroundColor: '#3b9eff',
  },
  keyText: {
    color: '#ddd',
    fontSize: 18,
    fontWeight: 'bold',
  },
  keyTextFocused: {
    color: '#1a1a1a',
  },
  resultsList: {
    flex: 1,
  },
  resultItem: {
    height: RESULT_H - 8,
    marginBottom: 8,
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 3,
    borderColor: 'transparent',
  },
  resultItemFocused: {
    borderColor: '#ffffff',
    backgroundColor: '#16315a',
  },
  resultName: {
    color: '#fff',
    fontSize: 17,
    flexShrink: 1,
  },
  resultCount: {
    color: '#9aa',
    fontSize: 14,
    marginLeft: 12,
  },
  noResults: {
    color: '#777',
    fontSize: 16,
    padding: 20,
  },
  recentWrap: {
    flex: 1,
  },
  shuffleBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#5b2bd9',
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: 8,
    marginBottom: 14,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  shuffleBtnFocused: {
    borderColor: '#ffffff',
    backgroundColor: '#7a4dff',
    transform: [{scale: 1.05}],
  },
  shuffleText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
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
  backButton: {
    backgroundColor: '#3b9eff',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 16,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  backFocused: {
    borderColor: '#ffffff',
    backgroundColor: '#6db8ff',
  },
  backButtonText: {
    color: '#1a1a1a',
    fontWeight: 'bold',
  },
});
