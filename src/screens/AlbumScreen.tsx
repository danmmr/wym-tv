import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  FlatList,
  BackHandler,
} from 'react-native';
import Focusable from '../components/Focusable';
import {color as theme, radius, type as typeScale} from '../theme';
import {captureDpad, subscribeNav} from '../nav/dpad';
import {useFocusEffect} from '@react-navigation/native';
import {useDeviceStore} from '../store/deviceStore';
import {usePlayerStore} from '../store/playerStore';
import {WiiMClient} from '../api/wiim';
import {
  getAlbumTracks,
  buildAlbumQueue,
  artUrl,
  PlexAlbum,
  PlexTrack,
} from '../api/plex';

// The Fire Stick reports a 960x540 dp window (1080p panel at density 320), so
// vertical space here is tight: every dp spent on the header or the bottom
// inset is a track row that doesn't fit. Sized so ~6 rows are visible.
const ROW_H = 48;
const VISIBLE = 6; // seed; the real count is measured onLayout

// Track listing for one album, opened with the MENU (☰) key from Browse. OK on
// a track starts the album from THAT track — the whole album still goes to the
// WiiM as one queue, so the rest of it plays on afterwards.
export default function AlbumScreen({route, navigation}: any) {
  const album: PlexAlbum = route?.params?.album;
  const selectedDevice = useDeviceStore(s => s.selectedDevice);
  const clientRef = useRef<WiiMClient | null>(null);

  const [tracks, setTracks] = useState<PlexTrack[]>([]);
  const [focus, setFocus] = useState(0);
  const [status, setStatus] = useState('Loading tracks…');

  const listRef = useRef<FlatList<PlexTrack>>(null);
  const topRef = useRef(0);
  const visibleRowsRef = useRef(VISIBLE);
  const busyRef = useRef(false);

  // Mirrors for the once-registered key handler.
  const focusRef = useRef(0);
  const tracksRef = useRef<PlexTrack[]>([]);
  // Focus moves are written to the ref SYNCHRONOUSLY, not in an effect.
  // The D-pad handler computes the next position from the ref, and an effect
  // only runs after React commits — so two presses arriving before that commit
  // both read the same stale position, the second computes the same
  // destination, and one of the two presses is silently lost. Five presses,
  // three moves. It reads as lag, and it is worst at startup when the JS thread
  // is busy and commits are slowest.
  const moveFocus = (n: number) => {
    focusRef.current = n;
    setFocus(n);
  };
  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  const scrollTo = (row: number) => {
    const vis = visibleRowsRef.current;
    let top = topRef.current;
    if (row < top) {
      top = row;
    } else if (row > top + vis - 1) {
      top = row - vis + 1;
    }
    if (top !== topRef.current) {
      topRef.current = top;
      listRef.current?.scrollToOffset({offset: top * ROW_H, animated: true});
    }
  };

  useEffect(() => {
    if (!selectedDevice) {
      navigation.navigate('Discovery');
      return;
    }
    clientRef.current = new WiiMClient(selectedDevice.ip);
    if (!album) {
      setStatus('No album');
      return;
    }
    (async () => {
      try {
        const list = await getAlbumTracks(album.ratingKey);
        setTracks(list);
        tracksRef.current = list;
        setStatus(list.length ? '' : 'No playable tracks on this album');
      } catch (e: any) {
        setStatus('Could not load tracks');
      }
    })();
  }, [selectedDevice, album, navigation]);

  // Play the album starting at `i` (0-based). Builds the same queue the Browse
  // "play album" path builds, so metadata and auto-advance behave identically.
  const playFrom = async (i: number) => {
    const c = clientRef.current;
    if (!c || busyRef.current || !album) {
      return;
    }
    busyRef.current = true;
    const t = tracksRef.current[i];
    setStatus(`Playing "${t ? t.title : album.title}"…`);
    try {
      const queue = await buildAlbumQueue(album);
      if (!queue.length) {
        setStatus('No playable tracks on this album');
        return;
      }
      // A finite album supersedes any active station auto-refill.
      usePlayerStore.getState().setPlayerState({stationKind: null});
      await c.playAlbumQueue(queue, i);
      navigation.navigate('NowPlaying');
    } catch (e: any) {
      setStatus(`Playback failed: ${e?.message || 'error'}`);
    } finally {
      busyRef.current = false;
    }
  };

  useFocusEffect(
    useCallback(() => {
      captureDpad();
      const sub = subscribeNav((k: string) => {
        const f = focusRef.current;
        const n = tracksRef.current.length;
        if (k === 'up') {
          if (f > 0) {
            moveFocus(f - 1);
            scrollTo(f - 1);
          }
        } else if (k === 'down') {
          if (f + 1 < n) {
            moveFocus(f + 1);
            scrollTo(f + 1);
          }
        } else if (k === 'left') {
          navigation.goBack();
        } else if (k === 'select') {
          playFrom(f);
        }
      });
      const back = BackHandler.addEventListener('hardwareBackPress', () => {
        navigation.goBack();
        return true;
      });
      return () => {
        sub();
        back.remove();
      };
      // The D-pad listener is registered ONCE and reads live values through
      // refs. Adding playFrom here would re-register it on every render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [navigation]),
  );

  const totalMs = tracks.reduce(
    (sum, t) => sum + (Number(t.durationMs) || 0),
    0,
  );

  const renderRow = ({item, index: i}: {item: PlexTrack; index: number}) => {
    const isFocused = focus === i;
    return (
      <Focusable
        focused={isFocused}
        scale={1.02}
        ringColor={theme.accentFallback}
        style={styles.row}>
        <Text style={styles.num}>{i + 1}</Text>
        <View style={styles.rowText}>
          <Text style={styles.title} numberOfLines={1}>
            {item.title}
          </Text>
          {/* Artist only when it differs from the album artist — otherwise it's
              the same name repeated down the whole list. Matters on
              compilations, where every track is a different artist. */}
          {item.artist && item.artist !== album?.artist ? (
            <Text style={styles.artist} numberOfLines={1}>
              {item.artist}
            </Text>
          ) : null}
        </View>
        <Text style={styles.dur}>{fmtDur(item.durationMs)}</Text>
      </Focusable>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        {album?.thumb ? (
          <Image source={{uri: artUrl(album.thumb, 320)}} style={styles.art} />
        ) : (
          <View style={[styles.art, styles.artEmpty]} />
        )}
        <View style={styles.headerText}>
          <Text style={styles.heading} numberOfLines={2}>
            {album?.title || 'Album'}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {album?.artist}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {[
              album?.year,
              tracks.length
                ? `${tracks.length} track${tracks.length === 1 ? '' : 's'}`
                : '',
              totalMs ? fmtDur(String(totalMs)) : '',
            ]
              .filter(Boolean)
              .join('  ·  ')}
          </Text>
        </View>
      </View>

      {status ? <Text style={styles.status}>{status}</Text> : null}

      <FlatList
        ref={listRef}
        data={tracks}
        renderItem={renderRow}
        keyExtractor={(t, i) => `${t.ratingKey}-${i}`}
        extraData={focus}
        style={styles.list}
        initialNumToRender={24}
        onLayout={e => {
          visibleRowsRef.current = Math.max(
            1,
            Math.floor(e.nativeEvent.layout.height / ROW_H),
          );
        }}
        getItemLayout={(_d, i) => ({
          length: ROW_H,
          offset: ROW_H * i,
          index: i,
        })}
      />

      <Text style={styles.hint}>
        OK: play from this track · LEFT/BACK: Browse
      </Text>
    </View>
  );
}

// ms → m:ss, or h:mm:ss once it passes an hour (album totals usually do not,
// but box sets do).
function fmtDur(ms: string): string {
  const total = Math.round((Number(ms) || 0) / 1000);
  if (!total) {
    return '';
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    paddingHorizontal: 48,
    paddingTop: 12,
    // Overscan-safe bottom inset. Smaller than the 140 Now Playing and Queue
    // use: on a 540dp-tall window that would eat 26% of the screen and cost
    // this list half its rows. 96dp is ~18%, still well clear of the ~10% the
    // TV crops, and the hint line is the only thing near the edge.
    paddingBottom: 96,
  },
  header: {flexDirection: 'row', alignItems: 'center', marginBottom: 10},
  art: {width: 88, height: 88, borderRadius: 8, backgroundColor: '#1a1a1a'},
  artEmpty: {borderWidth: 1, borderColor: '#2a2a2a'},
  headerText: {flex: 1, marginLeft: 16},
  heading: {...typeScale.title, color: theme.textPrimary},
  sub: {...typeScale.body, color: theme.accentFallback, marginTop: 2},
  meta: {...typeScale.caption, color: theme.textDim, marginTop: 3},
  status: {...typeScale.caption, color: theme.textDim, marginBottom: 6},
  list: {flex: 1},
  // Track row. The 3dp white border and #16315a fill are gone, as everywhere
  // else — focus is the accent ring plus brightness now.
  row: {
    height: ROW_H - 6,
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: radius.md,
    paddingHorizontal: 14,
  },
  num: {
    width: 34,
    ...typeScale.caption,
    color: theme.textDim,
    fontWeight: 'bold',
  },
  rowText: {flex: 1},
  title: {...typeScale.body, fontWeight: '400', color: theme.textPrimary},
  artist: {...typeScale.caption, color: theme.textDim, marginTop: 1},
  dur: {...typeScale.caption, color: theme.textDim, marginLeft: 12},
  hint: {
    ...typeScale.caption,
    color: theme.textDim,
    textAlign: 'center',
    marginTop: 8,
  },
});
