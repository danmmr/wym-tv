import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, FlatList, BackHandler} from 'react-native';
import Focusable from '../components/Focusable';
import Icon from '../components/Icon';
import {color as theme, radius, space, type as typeScale} from '../theme';
import {captureDpad, subscribeNav} from '../nav/dpad';
import {useFocusEffect} from '@react-navigation/native';
import {useDeviceStore} from '../store/deviceStore';
import {WiiMClient, QueueItem, queueDisplayName} from '../api/wiim';

// The Fire Stick window is 960x540 dp (1080p panel at density 320), so the
// vertical budget here is small — see the note on paddingBottom below.
const ROW_H = 48;
const VISIBLE = 6; // seed only; the real count is measured onLayout

// Focus model: 0 = the shuffle button, 1..N = the track at that 1-based index.
export default function QueueScreen({navigation}: any) {
  const selectedDevice = useDeviceStore(s => s.selectedDevice);
  const clientRef = useRef<WiiMClient | null>(null);

  const [items, setItems] = useState<QueueItem[]>([]);
  const [listName, setListName] = useState('');
  const [current, setCurrent] = useState(0); // 1-based currently-playing index
  const [shuffle, setShuffle] = useState(false);
  const [focus, setFocus] = useState(0);
  const [status, setStatus] = useState('Loading queue…');

  const listRef = useRef<FlatList<QueueItem>>(null);
  const topRef = useRef(0);
  // Real number of rows that fit, measured from the list's laid-out height
  // (overscan + chrome make a fixed guess wrong). Seeded, updated onLayout.
  const visibleRowsRef = useRef(VISIBLE);

  // Mirrors for the once-registered key handler.
  const focusRef = useRef(0);
  const itemsRef = useRef<QueueItem[]>([]);
  const listNameRef = useRef('');
  const shuffleRef = useRef(false);
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
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    listNameRef.current = listName;
  }, [listName]);
  useEffect(() => {
    shuffleRef.current = shuffle;
  }, [shuffle]);

  const scrollToTrack = (oneBased: number) => {
    const row = Math.max(0, oneBased - 1);
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

  const load = useCallback(async () => {
    const c = clientRef.current;
    if (!c) {
      return;
    }
    try {
      const [q, st] = await Promise.all([c.browseQueue(), c.getStatus()]);
      const cur = parseInt(st.plicurr, 10) || 0;
      const loop = parseInt(st.loop, 10);
      setItems(q.items);
      setListName(q.listName);
      setCurrent(cur);
      setShuffle(loop === 2 || loop === 3);
      setStatus(q.items.length ? '' : 'Queue is empty');
      const f = cur > 0 ? cur : 1;
      moveFocus(f);
      setTimeout(() => scrollToTrack(f), 0);
    } catch (e: any) {
      setStatus('Could not read the queue');
    }
  }, []);

  useEffect(() => {
    if (!selectedDevice) {
      navigation.navigate('Discovery');
      return;
    }
    clientRef.current = new WiiMClient(selectedDevice.ip);
    load();
    // Keep the "now playing" highlight fresh as the queue auto-advances.
    const iv = setInterval(async () => {
      const c = clientRef.current;
      if (!c) {
        return;
      }
      try {
        const st = await c.getStatus();
        setCurrent(parseInt(st.plicurr, 10) || 0);
      } catch {}
    }, 4000);
    return () => clearInterval(iv);
  }, [selectedDevice, navigation, load]);

  const toggleShuffle = async () => {
    const c = clientRef.current;
    if (!c) {
      return;
    }
    const on = !shuffleRef.current;
    setShuffle(on);
    try {
      await c.setLoopMode(on ? 3 : 4);
    } catch {}
  };

  const skipTo = async (oneBased: number) => {
    const c = clientRef.current;
    if (!c) {
      return;
    }
    setStatus('Jumping…');
    try {
      await c.playIndex(listNameRef.current, oneBased);
      setCurrent(oneBased);
      setStatus('');
    } catch (e: any) {
      setStatus('Jump failed');
    }
  };

  useFocusEffect(
    useCallback(() => {
      captureDpad();
      const sub = subscribeNav((k: string) => {
        const f = focusRef.current;
        const n = itemsRef.current.length;
        if (k === 'up') {
          if (f <= 1) {
            moveFocus(0);
          } else {
            const nf = f - 1;
            moveFocus(nf);
            scrollToTrack(nf);
          }
        } else if (k === 'down') {
          if (f === 0) {
            moveFocus(1);
            scrollToTrack(1);
          } else if (f < n) {
            const nf = f + 1;
            moveFocus(nf);
            scrollToTrack(nf);
          }
        } else if (k === 'left') {
          navigation.navigate('NowPlaying');
        } else if (k === 'select') {
          if (f === 0) {
            toggleShuffle();
          } else {
            skipTo(f);
          }
        }
      });
      const back = BackHandler.addEventListener('hardwareBackPress', () => {
        navigation.navigate('NowPlaying');
        return true;
      });
      return () => {
        sub();
        back.remove();
      };
    }, [navigation]),
  );

  const renderRow = ({item}: {item: QueueItem}) => {
    const isCurrent = item.index === current;
    const isFocused = focus === item.index;
    return (
      <Focusable
        focused={isFocused}
        scale={1.02}
        ringColor={theme.accentFallback}
        style={styles.row}>
        {/* The playing row is marked with a Skia glyph rather than a ▶
            character, which Fire OS drew from the emoji font at a different
            weight and baseline from the track numbers it sits among. */}
        <View style={styles.num}>
          {isCurrent ? (
            <Icon name="play" size={15} color={theme.nowPlaying} />
          ) : (
            <Text style={styles.numText}>{item.index}</Text>
          )}
        </View>
        <View style={styles.rowText}>
          <Text
            style={[styles.title, isCurrent && styles.titleCurrent]}
            numberOfLines={1}>
            {item.title}
          </Text>
          {item.artist ? (
            <Text style={styles.artist} numberOfLines={1}>
              {item.artist}
            </Text>
          ) : null}
        </View>
      </Focusable>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.heading}>Queue</Text>
        <Text style={styles.sub} numberOfLines={1}>
          {queueDisplayName(listName)}
          {items.length ? `  ·  ${items.length} tracks` : ''}
        </Text>
      </View>

      <Focusable
        focused={focus === 0}
        scale={1.06}
        ringColor={theme.accentFallback}
        style={styles.shuffle}>
        <Icon
          name="shuffle"
          size={18}
          color={shuffle ? theme.nowPlaying : theme.textDim}
        />
        <Text style={styles.shuffleText}>
          {`Shuffle: ${shuffle ? 'On' : 'Off'}`}
        </Text>
      </Focusable>

      {status ? <Text style={styles.status}>{status}</Text> : null}

      <FlatList
        ref={listRef}
        data={items}
        renderItem={renderRow}
        keyExtractor={it => String(it.index)}
        extraData={`${focus}:${current}`}
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
        OK: jump to track · LEFT/BACK: Now Playing
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    paddingHorizontal: 48,
    paddingTop: 12,
    // Overscan-safe bottom inset. 140 (what Now Playing uses) is 26% of a
    // 540dp-tall window and left this list showing only 3-4 tracks. 96dp is
    // ~18%, still well clear of the ~10% the TV crops.
    paddingBottom: 96,
  },
  header: {marginBottom: 8},
  heading: {...typeScale.title, color: theme.textPrimary},
  sub: {...typeScale.caption, color: theme.textDim, marginTop: 2},
  // The icon carries the on/off state by tinting, so the row does not need a
  // fill that changes colour underneath it.
  shuffle: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.sm,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginBottom: 8,
  },
  shuffleText: {...typeScale.label, color: theme.textPrimary},
  status: {...typeScale.caption, color: theme.textDim, marginBottom: 6},
  list: {flex: 1},
  row: {
    height: ROW_H - 6,
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: radius.md,
    paddingHorizontal: 14,
  },
  num: {width: 34, alignItems: 'flex-start', justifyContent: 'center'},
  numText: {...typeScale.body, color: theme.textDim, fontWeight: 'bold'},
  rowText: {flex: 1},
  title: {...typeScale.body, fontWeight: '400', color: theme.textPrimary},
  titleCurrent: {color: theme.nowPlaying, fontWeight: 'bold'},
  artist: {...typeScale.caption, color: theme.textDim, marginTop: 1},
  hint: {
    ...typeScale.caption,
    color: theme.textDim,
    textAlign: 'center',
    marginTop: 8,
  },
});
