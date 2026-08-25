import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  Dimensions,
  DeviceEventEmitter,
  BackHandler,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {captureDpad, subscribeNav} from '../nav/dpad';
import {useFocusEffect} from '@react-navigation/native';
import Icon from '../components/Icon';
import type {IconName} from '../components/Icon';
import Focusable from '../components/Focusable';
import Scrim from '../components/Scrim';
import {color, motion, onArt, radius, space, type} from '../theme';

// 2D control grid for D-pad navigation: left/right within a row, up/down
// between rows. Matches the on-screen layout for intuitive movement.
//
// This used to be six rows of pill buttons — every action one press away, which
// is why it was built that way, but it made the player look like a settings
// screen with art behind it. The nine secondary actions moved into the ⋮ menu
// overlay below; what stays on the hero is transport, volume, and the way in.
const ROWS: string[][] = [
  ['prev', 'play', 'next', 'more'],
  ['vdown', 'vup'],
];

// The overlay's own grid. Same key names as before, so activate() is unchanged
// and every action behaves exactly as it did — only where you reach it moved.
const MENU_ROWS: string[][] = [
  ['lucky', 'queue', 'album'],
  ['libradio', 'deepcuts', 'recent'],
  ['browse', 'settings', 'saver'],
];

// Labels and glyphs for the overlay, keyed the same way. Kept beside MENU_ROWS
// so adding an action means touching one place, not three.
const MENU_META: Record<string, {label: string; icon: IconName}> = {
  lucky: {label: 'Feeling Lucky', icon: 'dice'},
  queue: {label: 'Queue', icon: 'queue'},
  album: {label: 'Album', icon: 'album'},
  libradio: {label: 'Library Radio', icon: 'radio'},
  deepcuts: {label: 'Deep Cuts', icon: 'deepcuts'},
  recent: {label: 'Recently Added', icon: 'recent'},
  browse: {label: 'Browse', icon: 'browse'},
  settings: {label: 'Settings', icon: 'settings'},
  saver: {label: 'Screensaver', icon: 'screensaver'},
};

// The window is 960x540 dp (1080p at density 320). Vertical space is the scarce
// resource here, not horizontal, so the hero cover is sized off height.
const {height: WIN_H} = Dimensions.get('window');
const COVER = Math.round(WIN_H * 0.44);
import {useDeviceStore} from '../store/deviceStore';
import {usePlayerStore} from '../store/playerStore';
import {WiiMClient} from '../api/wiim';
import {
  getRandomAlbum,
  buildAlbumQueue,
  buildStationQueue,
  getTrackInfo,
} from '../api/plex';
import type {StationKind} from '../api/plex';
import {decodeHex} from '../api/hex';
import {useAlbumArt} from '../hooks/useAlbumArt';
import {useAccentColor, DEFAULT_ACCENT} from '../hooks/useAccentColor';
import Screensaver, {VISUALIZERS} from '../components/Screensaver';
import ArtFrame from '../components/ArtFrame';

// What the screensaver can show. The four shader visualizers plus the digital
// art frame, which used to be a separate mode entered from the ☰ button and is
// now simply the fifth thing the saver can be.
//
// Five modes do not fit four D-pad directions, so the old "each direction picks
// a visualizer" mapping is gone: left and right step through this list instead,
// which is also the only scheme that still works if a sixth is ever added.
const SAVER_MODES = [...VISUALIZERS, 'artframe'] as const;

export default function NowPlayingScreen({navigation}: any) {
  const selectedDevice = useDeviceStore(s => s.selectedDevice);
  const playerState = usePlayerStore();
  const [, setClient] = useState<WiiMClient | null>(null);
  const [showScreensaver, setShowScreensaver] = useState(false);
  const [vizIndex, setVizIndex] = useState(0);
  // The screensaver's album art shows a song-progress ring only when asked for
  // — OFF by default, toggled with the menu/options button while the saver is
  // up. It replaces the old always-on beat ring.
  const [showProgressRing, setShowProgressRing] = useState(false);
  const [lastAction, setLastAction] = useState('');
  const [connection, setConnection] = useState<'ok' | 'reconnecting'>('ok');
  const [focusRow, setFocusRow] = useState(0);
  const [focusCol, setFocusCol] = useState(1); // default: Play
  const focusPosRef = useRef({row: 0, col: 1});
  // The ⋮ overlay holding the nine secondary actions. Its focus position is
  // kept in a ref for the same reason the hero's is — see moveFocus below.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({row: 0, col: 0});
  const menuPosRef = useRef({row: 0, col: 0});
  const menuOpenRef = useRef(false);
  // Volume is a transient overlay, not a permanent row: showing the bar only
  // while it is being changed is what buys the hero its vertical space.
  const [volumeShown, setVolumeShown] = useState(false);
  const volumeTimerRef = useRef<NodeJS.Timeout>();
  const showScreensaverRef = useRef(false);
  const focusedKey = ROWS[focusRow]?.[focusCol];
  const pollTimeoutRef = useRef<NodeJS.Timeout>();
  // Consecutive failed polls. Drives the reconnecting banner and a backoff so a
  // dropped WiiM/Plex isn't hammered every 1.5s while it's unreachable.
  const failCountRef = useRef(0);
  const inactivityTimerRef = useRef<NodeJS.Timeout>();
  const clientRef = useRef<WiiMClient | null>(null);
  const {albumArt} = useAlbumArt();
  // Derive a vibrant accent from the current cover art and mirror it into the
  // store; the whole player chrome tints to it, falling back to the default blue.
  useAccentColor();
  const accent = playerState.accent || DEFAULT_ACCENT;
  // Station auto-refill bookkeeping. refillingRef guards against overlapping
  // appends; refillAtRef remembers the queue size we last refilled at so we
  // don't append again until the device reflects the growth.
  const refillingRef = useRef(false);
  const refillAtRef = useRef(0);
  // Codec is fetched from Plex once per track (the WiiM API lacks it); remember
  // which trackId we last looked up so the poll loop doesn't refetch each tick.
  const codecTrackRef = useRef<string>('');
  const REFILL_THRESHOLD = 10; // append when <= this many tracks remain
  const STATION_SIZE = 50;
  const POLL_INTERVAL = 1500; // normal cadence when the device is reachable
  const MAX_POLL_INTERVAL = 10000; // backoff ceiling while unreachable

  const fmt = (ms: number) => {
    if (!ms || ms < 0) {
      return '0:00';
    }
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Quality tier badge from codec + depth + rate. Hi-Res = 24-bit or above
  // 48 kHz (the standard Hi-Res Audio bar); lossless codecs at CD spec get a
  // "Lossless" pill; recognized lossy codecs get a dim "Lossy" tag; unknown =
  // no badge.
  //
  // The pill says the TIER and nothing else. It used to fall back to the codec
  // name for lossy tracks, which meant the one case worth calling out was the
  // only one that never said what it was — an MP3 read as "MP3".
  //
  // It also used to sit beside a formatLine() reading "FLAC · 16-bit · 44.1 kHz
  // · 564 kbps". That is gone by request: the question this screen answers from
  // the couch is whether the track is any good, not what its bit depth is.
  // codec/bitDepth/sampleRate are still fetched — resTier needs them to decide
  // the tier — they are simply no longer printed.
  const resTier = (): {label: string; bg: string; fg: string} | null => {
    const codec = (playerState.codec || '').toUpperCase();
    const depth = parseInt(playerState.bitDepth || '0', 10);
    const rate = parseInt(playerState.sampleRate || '0', 10);
    const lossy = /MP3|AAC|OGG|VORB|WMA|OPUS|M4A/.test(codec);
    const lossless = /FLAC|ALAC|WAV|AIFF|PCM|DSD/.test(codec);
    const hiRes = depth >= 24 || rate > 48000;
    if (hiRes && !lossy) {
      return {label: 'HI-RES', bg: '#c9a13b', fg: '#0a0a0a'};
    }
    if (lossless || (!lossy && depth === 16 && rate > 0)) {
      return {label: 'LOSSLESS', bg: '#2f6fb0', fg: '#ffffff'};
    }
    if (lossy) {
      return {label: 'LOSSY', bg: '#3a3a3a', fg: '#d0d0d0'};
    }
    return null;
  };

  const INACTIVITY_TIMEOUT = 2 * 60 * 1000; // 2 minutes

  const resetInactivityTimer = () => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
    }
    inactivityTimerRef.current = setTimeout(() => {
      setShowScreensaver(true);
    }, INACTIVITY_TIMEOUT);
  };

  const handleScreensaverExit = () => {
    setShowScreensaver(false);
    resetInactivityTimer();
  };

  // Pull current status from the device into the store. Returns true on
  // success so the poll loop can track reachability. getStatus is the core
  // call; a failure here means the WiiM is unreachable (network drop, etc).
  const pollStatus = async (): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) {
      return false;
    }
    try {
      // getMetaInfo carries sampleRate/bitDepth/bitRate but can fail (returns
      // a plain "Failed" string) when nothing is playing — keep it optional so
      // it never blocks the core status update.
      const [status, meta] = await Promise.all([
        c.getStatus(),
        c.getMetaInfo().catch(() => null),
      ]);
      const md = meta && typeof meta === 'object' ? meta.metaData : undefined;
      usePlayerStore.getState().setPlayerState({
        status: status.status as any,
        title: decodeHex(status.Title) || 'Unknown',
        artist: decodeHex(status.Artist) || 'Unknown Artist',
        album: decodeHex(status.Album) || 'Unknown Album',
        currentPos: parseInt(status.curpos, 10),
        duration: parseInt(status.totlen, 10),
        volume: parseInt(status.vol, 10),
        mute: status.mute === '1',
        sampleRate: md?.sampleRate || undefined,
        bitDepth: md?.bitDepth || undefined,
        bitRate: md?.bitRate || undefined,
      });
      maybeRefillStation(c, status);
      maybeFetchTrackInfo(md?.trackId);
      return true;
    } catch (error) {
      return false;
    }
  };

  // Self-scheduling poll loop. On success we poll at the normal cadence; on
  // repeated failures we surface a "reconnecting" banner and back off
  // exponentially (up to MAX_POLL_INTERVAL) so an unreachable device isn't
  // hammered — then snap back to normal the moment it responds again.
  const scheduleNextPoll = () => {
    const fails = failCountRef.current;
    const delay =
      fails === 0
        ? POLL_INTERVAL
        : Math.min(POLL_INTERVAL * 2 ** (fails - 1), MAX_POLL_INTERVAL);
    pollTimeoutRef.current = setTimeout(runPollCycle, delay);
  };

  const runPollCycle = async () => {
    const ok = await pollStatus();
    if (ok) {
      if (failCountRef.current !== 0) {
        failCountRef.current = 0;
        setConnection('ok');
      }
    } else {
      failCountRef.current += 1;
      // Tolerate a single blip; only flag reconnecting after 2 misses.
      if (failCountRef.current >= 2) {
        setConnection('reconnecting');
      }
    }
    scheduleNextPoll();
  };

  // Look up the codec (FLAC/ALAC/MP3) and the real per-track artist from Plex
  // when the track changes. Plex is the only source for either; cache by
  // trackId so we hit it once per track.
  const maybeFetchTrackInfo = (trackId?: string) => {
    if (!trackId || trackId === codecTrackRef.current) {
      return;
    }
    codecTrackRef.current = trackId;
    // Clear stale values so the previous track's codec/artist never shows
    // against the new one (artist falls back to the WiiM's own value).
    usePlayerStore.getState().setPlayerState({
      codec: undefined,
      trackArtist: undefined,
      albumRef: undefined,
    });
    getTrackInfo(trackId)
      .then(info => {
        // Ignore if the track changed again while we were fetching.
        if (codecTrackRef.current !== trackId) {
          return;
        }
        usePlayerStore.getState().setPlayerState({
          codec: info.codec || undefined,
          trackArtist: info.artist || undefined,
          albumRef: info.albumKey
            ? {
                key: info.albumKey,
                title: info.albumTitle,
                artist: info.albumArtist,
                thumb: info.albumThumb,
              }
            : undefined,
        });
      })
      .catch(() => {});
  };

  // When a station is driving the queue, keep it "endless" by appending another
  // batch as the queue nears its end. plicurr is 1-based; plicount is the queue
  // length. We only append once per drain (refillAtRef) and never overlap.
  const maybeRefillStation = (c: WiiMClient, status: any) => {
    const sk = usePlayerStore.getState().stationKind;
    if (!sk || refillingRef.current) {
      return;
    }
    const plicount = parseInt(status.plicount, 10) || 0;
    const plicurr = parseInt(status.plicurr, 10) || 0;
    if (plicount <= 0) {
      return;
    }
    const remaining = plicount - plicurr;
    if (remaining > REFILL_THRESHOLD) {
      return;
    }
    if (plicount === refillAtRef.current) {
      return;
    } // append not yet reflected
    refillingRef.current = true;
    refillAtRef.current = plicount;
    buildStationQueue(sk, STATION_SIZE)
      .then(q => (q.length ? c.appendQueue(q) : undefined))
      .catch(() => {
        refillAtRef.current = 0; // allow a retry on next drain
      })
      .finally(() => {
        refillingRef.current = false;
      });
  };

  // Run a control command, show feedback, and refresh immediately.
  const run = async (label: string, fn: () => Promise<void>) => {
    const c = clientRef.current;
    if (!c) {
      setLastAction('No device connected');
      return;
    }
    resetInactivityTimer();
    setLastAction(`${label}…`);
    try {
      await fn();
      setLastAction(`${label} ✓`);
      pollStatus();
    } catch (e: any) {
      setLastAction(`${label} — ${e?.message || 'error'}`);
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

    // Reset reachability tracking for the new device, then start the loop.
    failCountRef.current = 0;
    setConnection('ok');
    runPollCycle();

    // Start inactivity timer
    resetInactivityTimer();

    return () => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
      }
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
      }
    };
    // Boot effect: runs once per device. These are re-created each render, so
    // listing them would restart the poll loop continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice, navigation]);

  const handlePlayPause = () =>
    run('Play/Pause', async () => {
      const c = clientRef.current!;
      const st = usePlayerStore.getState().status;
      if (st === 'play') {
        await c.pause();
      } else {
        await c.resume();
      }
    });

  const handleNext = () => run('Next', () => clientRef.current!.next());
  const handlePrev = () => run('Prev', () => clientRef.current!.prev());

  // Play a random album from the Plex library on the WiiM. Uses its own status
  // feedback so it can show the picked album title.
  const handleFeelingLucky = async () => {
    const c = clientRef.current;
    if (!c) {
      setLastAction('No device connected');
      return;
    }
    resetInactivityTimer();
    // A finite album supersedes any active station — stop auto-refilling.
    usePlayerStore.getState().setPlayerState({stationKind: null});
    setLastAction('Finding an album…');
    try {
      const album = await getRandomAlbum();
      if (!album) {
        setLastAction('No albums found');
        return;
      }
      const queue = await buildAlbumQueue(album);
      if (!queue.length) {
        setLastAction(`No tracks in "${album.title}"`);
        return;
      }
      await c.playAlbumQueue(queue, 0);
      setLastAction(`${album.title} — ${album.artist}`);
      pollStatus();
    } catch (e: any) {
      setLastAction(`Feeling lucky — ${e?.message || 'error'}`);
    }
  };

  // Play the album the current track came from, from track 1. The album is
  // resolved by the per-track Plex lookup (see maybeFetchTrackInfo), so this
  // works for a track reached any way — station, playlist, lucky — not just
  // one played from Browse. Read albumRef from the STORE, never from render
  // scope: the WiiMNavKey listener is registered once, so a render-scope read
  // would be pinned to first-render values forever.
  const handlePlayAlbum = async () => {
    const c = clientRef.current;
    if (!c) {
      setLastAction('No device connected');
      return;
    }
    resetInactivityTimer();
    const ref = usePlayerStore.getState().albumRef;
    if (!ref?.key) {
      setLastAction('No album for this track');
      return;
    }
    // A finite album supersedes any active station — stop auto-refilling, or
    // the refill would append over this album's tail (shared queue name).
    usePlayerStore.getState().setPlayerState({stationKind: null});
    setLastAction(`Loading ${ref.title}…`);
    try {
      const queue = await buildAlbumQueue({
        ratingKey: ref.key,
        title: ref.title,
        artist: ref.artist,
        // buildAlbumQueue reads only ratingKey and thumb; the rest is display.
        artistKey: '',
        thumb: ref.thumb,
        year: '',
      });
      if (!queue.length) {
        setLastAction(`No tracks in "${ref.title}"`);
        return;
      }
      await c.playAlbumQueue(queue, 0);
      setLastAction(`${ref.title} — ${ref.artist}`);
      pollStatus();
    } catch (e: any) {
      setLastAction(`Album — ${e?.message || 'error'}`);
    }
  };

  // Start a "radio" station: build a finite queue of station tracks and push
  // it to the WiiM. Library = random across library; Deep Cuts = never-played.
  const handleStation = async (kind: StationKind, label: string) => {
    const c = clientRef.current;
    if (!c) {
      setLastAction('No device connected');
      return;
    }
    resetInactivityTimer();
    setLastAction(`${label}…`);
    try {
      const queue = await buildStationQueue(kind, STATION_SIZE);
      if (!queue.length) {
        setLastAction(`${label}: no tracks found`);
        return;
      }
      await c.playAlbumQueue(queue, 0);
      // Mark this as a station so the poll loop keeps it refilled.
      refillAtRef.current = 0;
      usePlayerStore.getState().setPlayerState({stationKind: kind});
      setLastAction(`${label} — auto-refilling`);
      pollStatus();
    } catch (e: any) {
      setLastAction(`${label} — ${e?.message || 'error'}`);
    }
  };

  // Reveal the volume bar and re-arm its hide timer. Called on every volume
  // press, so holding the key keeps the bar up rather than flickering it.
  const revealVolume = () => {
    setVolumeShown(true);
    clearTimeout(volumeTimerRef.current);
    volumeTimerRef.current = setTimeout(
      () => setVolumeShown(false),
      motion.volumeOverlay,
    );
  };

  const handleVolumeUp = () =>
    run('Vol +', async () => {
      revealVolume();
      const v = Math.min(100, usePlayerStore.getState().volume + 5);
      usePlayerStore.getState().setPlayerState({volume: v}); // optimistic
      await clientRef.current!.setVolume(v);
    });

  const handleVolumeDown = () =>
    run('Vol -', async () => {
      revealVolume();
      const v = Math.max(0, usePlayerStore.getState().volume - 5);
      usePlayerStore.getState().setPlayerState({volume: v}); // optimistic
      await clientRef.current!.setVolume(v);
    });

  // Invoke the action for a given control key.
  const activate = (key: string) => {
    switch (key) {
      case 'prev':
        handlePrev();
        break;
      case 'play':
        handlePlayPause();
        break;
      case 'next':
        handleNext();
        break;
      case 'vdown':
        handleVolumeDown();
        break;
      case 'vup':
        handleVolumeUp();
        break;
      case 'more':
        openMenu();
        break;
      case 'lucky':
        handleFeelingLucky();
        break;
      case 'queue':
        navigation.navigate('Queue');
        break;
      case 'libradio':
        handleStation('library', 'Library Radio');
        break;
      case 'deepcuts':
        handleStation('deepcuts', 'Deep Cuts');
        break;
      case 'recent':
        // Jump straight to Browse's Recent tab to pick a recently added album.
        navigation.navigate('Browse', {initialTab: 'recent'});
        break;
      case 'album':
        handlePlayAlbum();
        break;
      case 'browse':
        navigation.navigate('Browse');
        break;
      case 'settings':
        navigation.navigate('Settings');
        break;
      case 'saver':
        setShowScreensaver(true);
        break;
    }
  };

  const openMenu = () => {
    menuPosRef.current = {row: 0, col: 0};
    setMenuPos({row: 0, col: 0});
    menuOpenRef.current = true;
    setMenuOpen(true);
  };

  const closeMenu = () => {
    menuOpenRef.current = false;
    setMenuOpen(false);
  };

  // The overlay owns the D-pad while it is up, through its OWN subscription
  // rather than by branching inside the screen's handler.
  //
  // That works because nav/dpad.ts keeps a STACK of handlers and routes to the
  // top one: subscribing here pushes above the screen's handler, so the screen
  // stops seeing keys without either side knowing about the other, and popping
  // on close hands them straight back. Branching inside the screen's handler
  // would have been the alternative, but that handler is deliberately
  // registered once with no deps and reads everything through refs — adding a
  // second focus model to it is how it would start re-registering and dropping
  // presses again.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const unsub = subscribeNav((k: string) => {
      const {row, col} = menuPosRef.current;
      const moveMenu = (r: number, c: number) => {
        const rr = Math.min(Math.max(0, r), MENU_ROWS.length - 1);
        const cc = Math.min(Math.max(0, c), MENU_ROWS[rr].length - 1);
        menuPosRef.current = {row: rr, col: cc};
        setMenuPos({row: rr, col: cc});
      };
      if (k === 'left') {
        moveMenu(row, col - 1);
      } else if (k === 'right') {
        moveMenu(row, col + 1);
      } else if (k === 'up') {
        moveMenu(row - 1, col);
      } else if (k === 'down') {
        moveMenu(row + 1, col);
      } else if (k === 'select') {
        const {row: r, col: c} = menuPosRef.current;
        // Close FIRST: several of these navigate away, and leaving the overlay
        // mounted would keep its handler on top of the stack on the way out.
        closeMenu();
        activate(MENU_ROWS[r][c]);
      } else if (k === 'menu') {
        closeMenu();
      }
    });
    return unsub;
    // Subscribing depends only on the overlay being open; everything the
    // handler reads comes through refs, so it must not re-register per move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  // Clear the volume-hide timer on unmount so it cannot fire a setState into
  // an unmounted screen. Note the double arrow: clearTimeout returns undefined,
  // so returning its result directly would register no cleanup at all.
  useEffect(() => () => clearTimeout(volumeTimerRef.current), []);

  // Focus moves are written to the ref SYNCHRONOUSLY, not in an effect.
  // The D-pad handler computes the next position from the ref, and an effect
  // only runs after React commits — so two presses arriving before that commit
  // both read the same stale position, the second computes the same
  // destination, and one of the two presses is silently lost. Five presses,
  // three moves. It reads as lag, and it is worst at startup when the JS thread
  // is busy and commits are slowest.
  const moveFocus = (row: number, col: number) => {
    const c = Math.min(Math.max(0, col), ROWS[row].length - 1);
    focusPosRef.current = {row, col: c};
    setFocusRow(row);
    setFocusCol(c);
  };

  useEffect(() => {
    showScreensaverRef.current = showScreensaver;
  }, [showScreensaver]);

  // Own the D-pad only while this screen is focused. useFocusEffect runs on
  // focus and cleans up on blur, so Discovery and Now Playing never both grab
  // the D-pad at once.
  useFocusEffect(
    useCallback(() => {
      captureDpad();

      const navSub = subscribeNav((k: string) => {
        if (showScreensaverRef.current) {
          // Left and right step through SAVER_MODES, wrapping both ways.
          // OK/center and BACK dismiss; the menu/options button toggles the
          // album-art progress ring. Any other key also dismisses.
          //
          // Up and down are deliberately INERT rather than dismissing. They
          // used to pick starfield and metaball, so anyone reaching for a
          // visualizer the old way would otherwise be thrown back to Now
          // Playing by the fall-through.
          if (k === 'left') {
            setVizIndex(i => (i - 1 + SAVER_MODES.length) % SAVER_MODES.length);
          } else if (k === 'right') {
            setVizIndex(i => (i + 1) % SAVER_MODES.length);
          } else if (k === 'up' || k === 'down') {
            // inert
          } else if (k === 'select') {
            handleScreensaverExit(); // OK / center returns to Now Playing
          } else if (k === 'menu') {
            setShowProgressRing(p => !p); // menu button toggles the time-left ring
          } else {
            handleScreensaverExit();
          }
          return;
        }
        resetInactivityTimer();
        const {row, col} = focusPosRef.current;
        if (k === 'left') {
          moveFocus(row, col - 1);
        } else if (k === 'right') {
          moveFocus(row, col + 1);
        } else if (k === 'up') {
          moveFocus(Math.max(0, row - 1), col);
        } else if (k === 'down') {
          moveFocus(Math.min(ROWS.length - 1, row + 1), col);
        } else if (k === 'select') {
          const {row: r, col: c} = focusPosRef.current;
          activate(ROWS[r][c]);
        } else if (k === 'menu') {
          // The ☰ button opens the actions menu — the same overlay the ⋮
          // control opens, so the remote's menu key and the on-screen
          // affordance do the same thing. It used to jump straight to the art
          // frame; that moved into the overlay rather than being lost.
          openMenu();
        }
      });

      const mediaSub = DeviceEventEmitter.addListener(
        'WiiMRemoteKey',
        (key: string) => {
          if (showScreensaverRef.current) {
            handleScreensaverExit();
            return;
          }
          if (key === 'playPause') {
            handlePlayPause();
          } else if (key === 'next') {
            handleNext();
          } else if (key === 'prev') {
            handlePrev();
          }
        },
      );

      // Hardware BACK exits the screensaver and is consumed so it does not close
      // the app. When the screensaver is not up, fall through to default behavior.
      const backSub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (menuOpenRef.current) {
          closeMenu();
          return true;
        }
        if (showScreensaverRef.current) {
          handleScreensaverExit();
          return true;
        }
        return false;
      });

      // Note: we intentionally do NOT setCaptureDpad(false) on blur. Whichever
      // screen gains focus sets the desired value on focus, which avoids a race
      // where the old screen's blur cleanup runs after the new screen's focus.
      return () => {
        navSub();
        mediaSub.remove();
        backSub.remove();
      };
      // The D-pad listener is registered ONCE and reads live values through
      // refs. Listing these handlers would re-register it on every render — the
      // exact bug that made Browse silently stop playing.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  if (showScreensaver) {
    const mode = SAVER_MODES[vizIndex];
    // The art frame is a full screen of its own rather than a shader, so it
    // replaces the Screensaver outright instead of being a visualizer inside
    // it. The nav handler above still owns the keys either way.
    if (mode === 'artframe') {
      return <ArtFrame />;
    }
    return (
      <Screensaver
        onExit={handleScreensaverExit}
        visualizer={mode}
        showProgressRing={showProgressRing}
      />
    );
  }

  const tier = resTier();
  const progressPct =
    playerState.duration > 0
      ? Math.min(100, (playerState.currentPos / playerState.duration) * 100)
      : 0;

  return (
    <View style={styles.container}>
      {albumArt ? (
        <Image
          source={{uri: albumArt}}
          style={styles.bg}
          resizeMode="cover"
          blurRadius={8}
        />
      ) : null}
      {/* Bottom-weighted, so the art stays bright up top and the darkness sits
          under the metadata where the contrast is actually needed. */}
      <Scrim />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.navigate('Discovery')}>
          <Text style={[styles.deviceButton, {color: accent}]}>
            {selectedDevice?.name}
          </Text>
        </TouchableOpacity>
        {connection === 'reconnecting' ? (
          <Text style={styles.reconnecting}>reconnecting…</Text>
        ) : null}
      </View>

      <View style={styles.hero}>
        <AlbumCover uri={albumArt} accent={accent} />

        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={2}>
            {playerState.title}
          </Text>
          <Text style={[styles.artist, {color: accent}]} numberOfLines={1}>
            {playerState.trackArtist || playerState.artist}
          </Text>
          <Text style={styles.album} numberOfLines={1}>
            {playerState.album}
          </Text>

          {tier ? (
            <View style={styles.formatRow}>
              <View style={[styles.badge, {backgroundColor: tier.bg}]}>
                <Text style={[styles.badgeText, {color: tier.fg}]}>
                  {tier.label}
                </Text>
              </View>
            </View>
          ) : null}

          <View style={styles.progressRow}>
            <Text style={styles.time}>{fmt(playerState.currentPos)}</Text>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  {backgroundColor: accent, width: `${progressPct}%`},
                ]}
              />
              {/* Position dot at the fill head — the one cue that reads as a
                  scrubbing player rather than a loading bar. */}
              <View
                style={[
                  styles.progressDot,
                  {backgroundColor: accent, left: `${progressPct}%`},
                ]}
              />
            </View>
            <Text style={styles.time}>{fmt(playerState.duration)}</Text>
          </View>

          <View style={styles.transport}>
            {(
              [
                ['prev', 'prev'],
                ['play', playerState.status === 'play' ? 'pause' : 'play'],
                ['next', 'next'],
                ['more', 'more'],
              ] as [string, IconName][]
            ).map(([key, icon]) => (
              <Focusable
                key={key}
                focused={focusedKey === key}
                ringColor={accent}
                style={styles.control}>
                <Icon
                  name={icon}
                  size={key === 'play' ? 34 : 26}
                  color={focusedKey === key ? accent : color.textPrimary}
                />
              </Focusable>
            ))}
          </View>

          {/* The volume controls stay focusable at all times; only the BAR is
              transient, so the row never changes height as it appears. */}
          <View style={styles.volumeRow}>
            <Focusable
              focused={focusedKey === 'vdown'}
              ringColor={accent}
              style={styles.control}>
              <Icon
                name="volumeDown"
                size={22}
                color={focusedKey === 'vdown' ? accent : color.textPrimary}
              />
            </Focusable>
            <Focusable
              focused={focusedKey === 'vup'}
              ringColor={accent}
              style={styles.control}>
              <Icon
                name="volumeUp"
                size={22}
                color={focusedKey === 'vup' ? accent : color.textPrimary}
              />
            </Focusable>
            <VolumeBar
              shown={volumeShown || focusRow === 1}
              value={playerState.volume}
              accent={accent}
            />
          </View>
        </View>
      </View>

      {lastAction ? <Text style={styles.statusLine}>{lastAction}</Text> : null}

      {menuOpen ? (
        <View style={styles.menuOverlay}>
          <View style={styles.menuGrid}>
            {MENU_ROWS.map((row, r) => (
              <View key={r} style={styles.menuRow}>
                {row.map((key, c) => {
                  const meta = MENU_META[key];
                  const on = menuPos.row === r && menuPos.col === c;
                  return (
                    <Focusable
                      key={key}
                      focused={on}
                      scale={1.06}
                      ringColor={accent}
                      style={styles.menuItem}>
                      <Icon
                        name={meta.icon}
                        size={30}
                        color={on ? accent : color.textPrimary}
                      />
                      <Text style={styles.menuLabel}>{meta.label}</Text>
                    </Focusable>
                  );
                })}
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

// Album art that cross-fades on track change instead of popping.
//
// Two stacked images: the outgoing one stays mounted underneath at full opacity
// while the incoming one fades in over it. Fading the NEW image in (rather than
// the old one out) is what avoids a flash of background mid-change — there is
// never a moment when neither is opaque.
//
// The fade is keyed on the art URL, not on the track id: two tracks from the
// same album share a cover, and re-fading identical art reads as a glitch.
function AlbumCover({uri, accent}: {uri?: string; accent: string}) {
  const [layers, setLayers] = useState<{prev?: string; next?: string}>({
    next: uri,
  });
  // Tracks what is currently on top. A ref rather than reading `layers` in the
  // effect, so the effect does not have to depend on the state it sets.
  const shownRef = useRef(uri);
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (shownRef.current === uri) {
      return;
    }
    const outgoing = shownRef.current;
    shownRef.current = uri;
    // Drop the incoming layer to transparent BEFORE it paints, so the first
    // frame of the new cover is not a hard cut. Done here in the effect body,
    // never inside the setState updater — an updater must be pure, and React
    // is free to call it more than once per commit.
    opacity.value = 0;
    opacity.value = withTiming(1, {duration: motion.crossFade});
    setLayers({prev: outgoing, next: uri});
  }, [uri, opacity]);

  const topStyle = useAnimatedStyle(() => ({opacity: opacity.value}));

  const empty = (
    <View style={[styles.cover, styles.coverEmpty, {borderColor: accent}]}>
      <Icon name="album" size={COVER * 0.4} color={accent} />
    </View>
  );

  return (
    <View style={styles.coverStack}>
      {layers.prev ? (
        <Image
          source={{uri: layers.prev}}
          style={[styles.cover, styles.coverUnder, {borderColor: accent}]}
          resizeMode="cover"
        />
      ) : null}
      {layers.next ? (
        <Animated.Image
          source={{uri: layers.next}}
          style={[styles.cover, {borderColor: accent}, topStyle]}
          resizeMode="cover"
        />
      ) : (
        empty
      )}
    </View>
  );
}

// Volume bar that fades rather than unmounting. Kept as its own component so
// the fade lives in one useAnimatedStyle instead of re-rendering the hero on
// every volume press, and so the row keeps its height whether or not the bar
// is showing — a bar that unmounted would shift the transport row under it.
function VolumeBar({
  shown,
  value,
  accent,
}: {
  shown: boolean;
  value: number;
  accent: string;
}) {
  const opacity = useSharedValue(0);
  useEffect(() => {
    opacity.value = withTiming(shown ? 1 : 0, {duration: 180});
  }, [shown, opacity]);
  const style = useAnimatedStyle(() => ({opacity: opacity.value}));

  return (
    <Animated.View style={[styles.volumeBar, style]}>
      <View
        style={[
          styles.volumeFill,
          {backgroundColor: accent, width: `${value}%`},
        ]}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.bg,
    // Fire TV overscan-safe insets.
    //
    // The bottom inset used to be 110 — 20% of the 540dp screen — because the
    // old layout ended in a footer row of Browse / Settings / Screensaver
    // buttons that this TV's crop would otherwise eat. Those moved into the ⋮
    // overlay, which centres itself, so nothing is anchored to the bottom edge
    // any more and the reserve became dead space under the hero.
    //
    // 24 is kept rather than 0 because the transient status line still sits
    // below the hero, and a real panel does crop a few percent.
    paddingHorizontal: 48,
    paddingTop: 12,
    paddingBottom: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.sm,
  },
  deviceButton: {
    ...type.body,
    fontWeight: 'bold',
  },
  reconnecting: {
    ...type.caption,
    color: color.warn,
    fontWeight: '600',
    ...onArt,
  },
  // Album art blown up to fill the whole screen as a blurred background. Scaled
  // up slightly so the blur does not reveal soft edges at the screen borders.
  bg: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    transform: [{scale: 1.1}],
  },
  hero: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
  },
  // Fixed box so the two cross-fading layers stack without either affecting
  // layout, and so the metadata column never shifts as art loads.
  coverStack: {
    width: COVER,
    height: COVER,
  },
  coverUnder: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  cover: {
    width: COVER,
    height: COVER,
    borderRadius: radius.md,
    // Accent-tinted hairline: enough to separate the cover from a dark blurred
    // version of itself, not enough to read as a frame.
    borderWidth: 1,
  },
  coverEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  info: {
    flex: 1,
    justifyContent: 'center',
  },
  title: {
    ...type.hero,
    color: color.textPrimary,
    marginBottom: space.xs,
    ...onArt,
  },
  artist: {
    ...type.title,
    marginBottom: 2,
    ...onArt,
  },
  album: {
    ...type.body,
    color: color.textSecondary,
    fontWeight: '400',
    ...onArt,
  },
  formatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: space.sm,
  },
  // Quality-tier pill. It says the TIER — HI-RES / LOSSLESS / LOSSY — never the
  // codec; the codec is the first thing on the format line beside it.
  badge: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
  },
  badgeText: {
    ...type.badge,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.md,
  },
  time: {
    ...type.caption,
    color: color.textDim,
    marginHorizontal: space.sm,
    ...onArt,
  },
  progressBar: {
    flex: 1,
    height: 4,
    backgroundColor: color.track,
    borderRadius: 2,
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  progressDot: {
    position: 'absolute',
    top: -3,
    width: 10,
    height: 10,
    borderRadius: 5,
    // Pull back by half its width so the dot is centred ON the fill head
    // rather than starting at it.
    marginLeft: -5,
  },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.md,
    gap: space.md,
  },
  // The two speaker buttons sit ADJACENT, like the transport row above them,
  // and the bar is positioned absolutely beside them rather than laid out
  // between them.
  //
  // Two earlier goes at this were both wrong on the TV. flex:1 stretched the
  // row the full width of the screen and stranded the speakers at opposite
  // edges; a fixed 260dp bar still left a dead gap between them whenever it was
  // faded out. An opacity-0 view keeps its space — the fix is for the bar not
  // to occupy the row at all.
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: space.sm,
    gap: space.sm,
  },
  // One control box for every icon button. Fixed size so focus scaling never
  // reflows the row, and transparent so the icon carries the meaning.
  control: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  volumeBar: {
    // Absolute, so the row's width never depends on whether it is showing.
    // left clears the two 52dp buttons plus their 8dp gap, with a little air.
    position: 'absolute',
    left: 132,
    width: 260,
    height: 4,
    backgroundColor: color.track,
    borderRadius: 2,
  },
  volumeFill: {
    height: '100%',
    borderRadius: 2,
  },
  statusLine: {
    ...type.caption,
    color: color.textDim,
    textAlign: 'center',
    marginBottom: 2,
    ...onArt,
  },
  // The ⋮ overlay. Covers the whole screen including the container padding,
  // so it is positioned against the screen rather than laid out in the stack.
  menuOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(6,6,6,0.90)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuGrid: {
    gap: space.md,
  },
  menuRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.md,
  },
  menuItem: {
    width: 190,
    height: 104,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  menuLabel: {
    ...type.label,
    color: color.textPrimary,
  },
});
