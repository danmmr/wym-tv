import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  DeviceEventEmitter,
  NativeModules,
  BackHandler,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {useDeviceStore} from '../store/deviceStore';
import {WiiMClient, QueueItem} from '../api/wiim';

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
  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);
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
      setFocus(f);
      focusRef.current = f;
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
      NativeModules.RemoteControl?.setCaptureDpad(true);
      const sub = DeviceEventEmitter.addListener('WiiMNavKey', (k: string) => {
        const f = focusRef.current;
        const n = itemsRef.current.length;
        if (k === 'up') {
          if (f <= 1) {
            setFocus(0);
          } else {
            const nf = f - 1;
            setFocus(nf);
            scrollToTrack(nf);
          }
        } else if (k === 'down') {
          if (f === 0) {
            setFocus(1);
            scrollToTrack(1);
          } else if (f < n) {
            const nf = f + 1;
            setFocus(nf);
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
        sub.remove();
        back.remove();
      };
    }, [navigation]),
  );

  const renderRow = ({item}: {item: QueueItem}) => {
    const isCurrent = item.index === current;
    const isFocused = focus === item.index;
    return (
      <View style={[styles.row, isFocused && styles.rowFocused]}>
        <Text style={[styles.num, isCurrent && styles.numCurrent]}>
          {isCurrent ? '▶' : item.index}
        </Text>
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
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.heading}>Queue</Text>
        <Text style={styles.sub} numberOfLines={1}>
          {listName}
          {items.length ? `  ·  ${items.length} tracks` : ''}
        </Text>
      </View>

      <View style={[styles.shuffle, focus === 0 && styles.shuffleFocused]}>
        <Text style={styles.shuffleText}>
          {`🔀 Shuffle: ${shuffle ? 'On' : 'Off'}`}
        </Text>
      </View>

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
  heading: {fontSize: 20, fontWeight: 'bold', color: '#fff'},
  sub: {fontSize: 14, color: '#8b95a7', marginTop: 2},
  shuffle: {
    alignSelf: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: 'transparent',
    backgroundColor: '#16315a',
    marginBottom: 8,
  },
  shuffleFocused: {borderColor: '#ffffff', backgroundColor: '#1f4480'},
  shuffleText: {color: '#cfe0ff', fontWeight: 'bold', fontSize: 15},
  status: {color: '#3b9eff', fontSize: 13, marginBottom: 6},
  list: {flex: 1},
  row: {
    height: ROW_H - 6,
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#161a22',
    borderRadius: 8,
    paddingHorizontal: 14,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  rowFocused: {borderColor: '#ffffff', backgroundColor: '#16315a'},
  num: {
    width: 34,
    color: '#8b95a7',
    fontSize: 16,
    fontWeight: 'bold',
  },
  numCurrent: {color: '#46c08d'},
  rowText: {flex: 1},
  title: {color: '#fff', fontSize: 16},
  titleCurrent: {color: '#46c08d', fontWeight: 'bold'},
  artist: {color: '#8b95a7', fontSize: 13, marginTop: 1},
  hint: {color: '#5b6472', fontSize: 12, textAlign: 'center', marginTop: 8},
});
