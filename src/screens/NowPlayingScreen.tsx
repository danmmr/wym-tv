import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  DeviceEventEmitter,
  BackHandler,
} from 'react-native';
import {captureDpad, subscribeNav} from '../nav/dpad';
import {useFocusEffect} from '@react-navigation/native';

// 2D control grid for D-pad navigation: left/right within a row, up/down
// between rows. Matches the on-screen layout for intuitive movement.
const ROWS: string[][] = [
  ['prev', 'play', 'next'],
  ['vdown', 'vup'],
  ['lucky', 'queue'],
  ['libradio', 'deepcuts'],
  ['recent', 'album'],
  ['browse', 'settings', 'saver'],
];
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

export default function NowPlayingScreen({navigation}: any) {
  const selectedDevice = useDeviceStore(s => s.selectedDevice);
  const playerState = usePlayerStore();
  const [, setClient] = useState<WiiMClient | null>(null);
  const [showScreensaver, setShowScreensaver] = useState(false);
  const [showArtFrame, setShowArtFrame] = useState(false);
  const showArtFrameRef = useRef(false);
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

  // Build a "FLAC · 16-bit · 44.1 kHz · 320 kbps" line. Codec comes from Plex;
  // depth/rate/bitrate from the WiiM metaInfo. Each part shows only if known.
  const formatLine = (): string => {
    const parts: string[] = [];
    if (playerState.codec) {
      parts.push(playerState.codec);
    }
    if (playerState.bitDepth) {
      parts.push(`${playerState.bitDepth}-bit`);
    }
    if (playerState.sampleRate) {
      const hz = parseInt(playerState.sampleRate, 10);
      if (hz > 0) {
        const khz = hz / 1000;
        parts.push(`${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`);
      }
    }
    if (playerState.bitRate) {
      parts.push(`${playerState.bitRate} kbps`);
    }
    return parts.join('  ·  ');
  };

  // Quality tier badge from codec + depth + rate. Hi-Res = 24-bit or above
  // 48 kHz (the standard Hi-Res Audio bar); lossless codecs at CD spec get a
  // "Lossless" pill; recognized lossy codecs get a dim tag; unknown = no badge.
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
      return {label: codec || 'LOSSY', bg: '#3a3a3a', fg: '#d0d0d0'};
    }
    return null;
  };

  const INACTIVITY_TIMEOUT = 2 * 60 * 1000; // 2 minutes

  const resetInactivityTimer = () => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
    }
    inactivityTimerRef.current = setTimeout(() => {
      // Never let the shader screensaver replace the digital art frame while it
      // is up. exitArtFrame re-arms this timer, so the screensaver still kicks in
      // normally once the art frame is dismissed.
      if (showArtFrameRef.current) {
        return;
      }
      setShowScreensaver(true);
    }, INACTIVITY_TIMEOUT);
  };

  const handleScreensaverExit = () => {
    setShowScreensaver(false);
    resetInactivityTimer();
  };

  // Digital art frame: entered manually from the Menu button, dismissed on any
  // key. Suspend the inactivity timer while it is up so the shader screensaver
  // does not queue up behind it, and restart it on exit.
  const enterArtFrame = () => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
    }
    setShowArtFrame(true);
  };
  const exitArtFrame = () => {
    setShowArtFrame(false);
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
      setLastAction(`${label} ✗ ${e?.message || 'error'}`);
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
    setLastAction('🎲 Finding an album…');
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
      setLastAction(`🎲 ${album.title} — ${album.artist}`);
      pollStatus();
    } catch (e: any) {
      setLastAction(`Feeling lucky ✗ ${e?.message || 'error'}`);
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
    setLastAction(`💿 Loading ${ref.title}…`);
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
      setLastAction(`💿 ${ref.title} — ${ref.artist}`);
      pollStatus();
    } catch (e: any) {
      setLastAction(`Album ✗ ${e?.message || 'error'}`);
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
      setLastAction(`${label} ▶ auto-refilling`);
      pollStatus();
    } catch (e: any) {
      setLastAction(`${label} ✗ ${e?.message || 'error'}`);
    }
  };

  const handleVolumeUp = () =>
    run('Vol +', async () => {
      const v = Math.min(100, usePlayerStore.getState().volume + 5);
      usePlayerStore.getState().setPlayerState({volume: v}); // optimistic
      await clientRef.current!.setVolume(v);
    });

  const handleVolumeDown = () =>
    run('Vol -', async () => {
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
      case 'lucky':
        handleFeelingLucky();
        break;
      case 'queue':
        navigation.navigate('Queue');
        break;
      case 'libradio':
        handleStation('library', '📻 Library Radio');
        break;
      case 'deepcuts':
        handleStation('deepcuts', '🌊 Deep Cuts');
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

  useEffect(() => {
    showArtFrameRef.current = showArtFrame;
  }, [showArtFrame]);

  // Own the D-pad only while this screen is focused. useFocusEffect runs on
  // focus and cleans up on blur, so Discovery and Now Playing never both grab
  // the D-pad at once.
  useFocusEffect(
    useCallback(() => {
      captureDpad();

      const navSub = subscribeNav((k: string) => {
        if (showArtFrameRef.current) {
          exitArtFrame(); // any key dismisses the art frame
          return;
        }
        if (showScreensaverRef.current) {
          // While the screensaver is up, each D-pad direction selects a visualizer
          // (matches VISUALIZERS order: plasma, flow, starfield, metaball).
          // OK/center and BACK dismiss it; the menu/options button toggles the
          // album-art pulse. Any other key also dismisses.
          if (k === 'left') {
            setVizIndex(0); // plasma
          } else if (k === 'right') {
            setVizIndex(1); // flow
          } else if (k === 'up') {
            setVizIndex(2); // starfield / warp tunnel
          } else if (k === 'down') {
            setVizIndex(3); // metaball / lava lamp
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
          enterArtFrame(); // the ☰/options button opens the digital art frame
        }
      });

      const mediaSub = DeviceEventEmitter.addListener(
        'WiiMRemoteKey',
        (key: string) => {
          if (showArtFrameRef.current) {
            exitArtFrame();
            return;
          }
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
        if (showArtFrameRef.current) {
          exitArtFrame();
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

  if (showArtFrame) {
    return <ArtFrame />;
  }

  if (showScreensaver) {
    return (
      <Screensaver
        onExit={handleScreensaverExit}
        visualizer={VISUALIZERS[vizIndex]}
        showProgressRing={showProgressRing}
      />
    );
  }

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
      <View style={styles.scrim} pointerEvents="none" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.navigate('Discovery')}>
          <Text style={[styles.deviceButton, {color: accent}]}>
            {selectedDevice?.name}
          </Text>
        </TouchableOpacity>
        {connection === 'reconnecting' ? (
          <Text style={styles.reconnecting}>⟳ reconnecting…</Text>
        ) : null}
      </View>

      <View style={styles.artSpacer} />

      <View style={styles.infoContainer}>
        <Text style={styles.title}>{playerState.title}</Text>
        <Text style={[styles.artist, {color: accent}]}>
          {playerState.trackArtist || playerState.artist}
        </Text>
        <Text style={styles.album}>{playerState.album}</Text>
        {resTier() || formatLine() ? (
          <View style={styles.formatRow}>
            {resTier() ? (
              <View style={[styles.badge, {backgroundColor: resTier()!.bg}]}>
                <Text style={[styles.badgeText, {color: resTier()!.fg}]}>
                  {resTier()!.label}
                </Text>
              </View>
            ) : null}
            {formatLine() ? (
              <Text style={styles.format}>{formatLine()}</Text>
            ) : null}
          </View>
        ) : null}
      </View>

      <View style={styles.progressContainer}>
        <Text style={styles.time}>{fmt(playerState.currentPos)}</Text>
        <View style={styles.progressBar}>
          <View
            style={[
              styles.progressFill,
              {
                backgroundColor: accent,
                width: `${
                  playerState.duration > 0
                    ? Math.min(
                        100,
                        (playerState.currentPos / playerState.duration) * 100,
                      )
                    : 0
                }%`,
              },
            ]}
          />
        </View>
        <Text style={styles.time}>{fmt(playerState.duration)}</Text>
      </View>

      <View style={styles.controls}>
        <View
          style={[
            styles.button,
            {backgroundColor: accent},
            focusedKey === 'prev' && styles.buttonFocused,
          ]}>
          <Text style={styles.buttonText}>⏮ Prev</Text>
        </View>

        <View
          style={[
            styles.button,
            {backgroundColor: accent},
            focusedKey === 'play' && styles.buttonFocused,
          ]}>
          <Text style={styles.buttonText}>
            {playerState.status === 'play' ? '⏸ Pause' : '▶ Play'}
          </Text>
        </View>

        <View
          style={[
            styles.button,
            {backgroundColor: accent},
            focusedKey === 'next' && styles.buttonFocused,
          ]}>
          <Text style={styles.buttonText}>Next ⏭</Text>
        </View>
      </View>

      <View style={styles.volumeContainer}>
        <View
          style={[
            styles.volumeButton,
            focusedKey === 'vdown' && styles.volumeButtonFocused,
          ]}>
          <Text style={styles.volumeText}>🔉</Text>
        </View>
        <View style={styles.volumeBar}>
          <View
            style={[
              styles.volumeFill,
              {backgroundColor: accent, width: `${playerState.volume}%`},
            ]}
          />
        </View>
        <View
          style={[
            styles.volumeButton,
            focusedKey === 'vup' && styles.volumeButtonFocused,
          ]}>
          <Text style={styles.volumeText}>🔊</Text>
        </View>
      </View>

      <View style={styles.luckyRow}>
        <View
          style={[
            styles.luckyButton,
            focusedKey === 'lucky' && styles.luckyButtonFocused,
          ]}>
          <Text style={styles.luckyText}>🎲 Feeling lucky?</Text>
        </View>
        <View
          style={[
            styles.luckyButton,
            focusedKey === 'queue' && styles.luckyButtonFocused,
          ]}>
          <Text style={styles.luckyText}>☰ Queue</Text>
        </View>
      </View>

      <View style={styles.luckyRow}>
        <View
          style={[
            styles.luckyButton,
            focusedKey === 'libradio' && styles.luckyButtonFocused,
          ]}>
          <Text style={styles.luckyText}>📻 Library Radio</Text>
        </View>
        <View
          style={[
            styles.luckyButton,
            focusedKey === 'deepcuts' && styles.luckyButtonFocused,
          ]}>
          <Text style={styles.luckyText}>🌊 Deep Cuts</Text>
        </View>
      </View>

      <View style={styles.luckyRow}>
        <View
          style={[
            styles.luckyButton,
            focusedKey === 'recent' && styles.luckyButtonFocused,
          ]}>
          <Text style={styles.luckyText}>Recently Added</Text>
        </View>
        <View
          style={[
            styles.luckyButton,
            focusedKey === 'album' && styles.luckyButtonFocused,
          ]}>
          <Text style={styles.luckyText}>💿 Album</Text>
        </View>
      </View>

      {lastAction ? <Text style={styles.statusLine}>{lastAction}</Text> : null}

      <View style={styles.footer}>
        <View
          style={[
            styles.footerBtn,
            focusedKey === 'browse' && styles.footerBtnFocused,
          ]}>
          <Text style={[styles.footerLink, {color: accent}]}>Browse</Text>
        </View>
        <View
          style={[
            styles.footerBtn,
            focusedKey === 'settings' && styles.footerBtnFocused,
          ]}>
          <Text style={[styles.footerLink, {color: accent}]}>Settings</Text>
        </View>
        <View
          style={[
            styles.footerBtn,
            focusedKey === 'saver' && styles.footerBtnFocused,
          ]}>
          <Text style={[styles.footerLink, {color: accent}]}>Screensaver</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    // Fire TV overscan-safe insets: shift the whole stack up by trimming the top
    // inset and growing the bottom inset, so the footer clears this TV's crop.
    paddingHorizontal: 48,
    paddingTop: 12,
    paddingBottom: 110,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  deviceButton: {
    fontSize: 18,
    color: '#3b9eff',
    fontWeight: 'bold',
  },
  // Amber, with a shadow so it stays legible over bright blurred album art.
  reconnecting: {
    fontSize: 13,
    color: '#ffb84d',
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 4,
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
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  artSpacer: {
    flex: 1,
    minHeight: 16,
  },
  placeholderText: {
    fontSize: 120,
    color: '#3b9eff',
    fontWeight: 'bold',
  },
  infoContainer: {
    marginBottom: 2,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 4,
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 4,
  },
  artist: {
    fontSize: 18,
    color: '#5cb0ff',
    marginBottom: 4,
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 4,
  },
  album: {
    fontSize: 16,
    color: '#d2d2d2',
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 4,
  },
  formatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 6,
  },
  // Quality-tier pill (HI-RES / LOSSLESS / codec). Color comes in inline per tier.
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 5,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  // Brighter than the other dim greys + a shadow so the resolution/bitrate line
  // stays legible over bright album-art backgrounds (it used to vanish).
  format: {
    fontSize: 13,
    color: '#e2e2e2',
    letterSpacing: 1,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 4,
  },
  progressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  time: {
    color: '#888',
    fontSize: 12,
    marginHorizontal: 8,
  },
  progressBar: {
    flex: 1,
    height: 6,
    backgroundColor: '#333',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#3b9eff',
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 4,
    gap: 20,
  },
  button: {
    backgroundColor: '#3b9eff',
    paddingHorizontal: 25,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  // Focus = white ring + scale only, so the art-derived accent set inline on the
  // button stays visible rather than being overwritten by a fixed blue.
  buttonFocused: {
    borderColor: '#ffffff',
    transform: [{scale: 1.18}],
  },
  buttonText: {
    color: '#0a0a0a',
    fontSize: 16,
    fontWeight: 'bold',
  },
  volumeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  volumeButton: {
    marginHorizontal: 10,
    padding: 6,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  volumeButtonFocused: {
    borderColor: '#ffffff',
    backgroundColor: '#16315a',
    transform: [{scale: 1.15}],
  },
  volumeText: {
    fontSize: 24,
  },
  volumeBar: {
    flex: 1,
    height: 8,
    backgroundColor: '#333',
    borderRadius: 4,
    overflow: 'hidden',
    marginHorizontal: 10,
  },
  volumeFill: {
    height: '100%',
    backgroundColor: '#3b9eff',
  },
  luckyRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    marginBottom: 4,
  },
  luckyButton: {
    backgroundColor: '#5b2bd9',
    paddingHorizontal: 30,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  luckyButtonFocused: {
    borderColor: '#ffffff',
    backgroundColor: '#7a4dff',
    transform: [{scale: 1.12}],
  },
  luckyText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  statusLine: {
    color: '#3b9eff80',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 2,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 40,
  },
  footerBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  footerBtnFocused: {
    borderColor: '#ffffff',
    backgroundColor: '#16315a',
  },
  footerLink: {
    fontSize: 16,
    color: '#3b9eff',
    fontWeight: 'bold',
  },
});
