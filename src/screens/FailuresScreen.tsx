import React, {useCallback, useRef, useState} from 'react';
import {
  Alert,
  BackHandler,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import Focusable from '../components/Focusable';
import {captureDpad, subscribeNav} from '../nav/dpad';
import {
  clearFailures,
  describeKind,
  dumpFailures,
  FailureEntry,
  getFailures,
} from '../playback/failureLog';
import {color as theme, radius, type as typeScale} from '../theme';

const ROW_H = 76;
const VISIBLE = 4; // seed only; the real count is measured onLayout

// Tracks the WiiM could not play, with where each file lives. OK writes the list to
// logcat, and the menu key clears it. Opened from Settings.
export default function FailuresScreen({navigation}: any) {
  const [items, setItems] = useState<FailureEntry[]>([]);
  const [focus, setFocus] = useState(0);
  const [message, setMessage] = useState('');

  const listRef = useRef<FlatList<FailureEntry>>(null);
  const focusRef = useRef(0);
  const topRef = useRef(0);
  const countRef = useRef(0);
  const visibleRef = useRef(VISIBLE);

  const moveFocus = (n: number) => {
    focusRef.current = n;
    setFocus(n);
    let top = topRef.current;
    if (n < top) {
      top = n;
    } else if (n > top + visibleRef.current - 1) {
      top = n - visibleRef.current + 1;
    }
    if (top !== topRef.current) {
      topRef.current = top;
      listRef.current?.scrollToOffset({offset: top * ROW_H, animated: true});
    }
  };

  const confirmClear = () => {
    if (!countRef.current) {
      return;
    }
    Alert.alert('Clear the list?', 'This does not touch the files.', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          clearFailures();
          countRef.current = 0;
          setItems([]);
          moveFocus(0);
          setMessage('');
        },
      },
    ]);
  };

  useFocusEffect(
    useCallback(() => {
      captureDpad();
      getFailures().then(list => {
        countRef.current = list.length;
        setItems(list);
      });
      const sub = subscribeNav((k: string) => {
        const f = focusRef.current;
        if (k === 'up') {
          moveFocus(Math.max(0, f - 1));
        } else if (k === 'down') {
          moveFocus(Math.min(Math.max(0, countRef.current - 1), f + 1));
        } else if (k === 'left') {
          navigation.goBack();
        } else if (k === 'select') {
          dumpFailures().then(n => setMessage(`Wrote ${n} to the log`));
        } else if (k === 'menu') {
          confirmClear();
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
      // The D-pad listener is registered once and reads through refs.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const renderRow = ({item, index}: {item: FailureEntry; index: number}) => (
    <Focusable
      focused={focus === index}
      scale={1.02}
      ringColor={theme.accentFallback}
      style={styles.row}>
      <Text style={styles.title} numberOfLines={1}>
        {item.artist} — {item.title}
      </Text>
      <Text style={styles.detail} numberOfLines={1}>
        {describeKind(item)}
        {item.count > 1 ? `  ·  ${item.count} times` : ''}
        {`  ·  ${item.album}`}
      </Text>
      <Text style={styles.detail} numberOfLines={1} ellipsizeMode="head">
        {item.file || item.trackId}
      </Text>
    </Focusable>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Playback Failures</Text>
      <Text style={styles.sub}>
        {message ||
          (items.length
            ? `${items.length} ${items.length === 1 ? 'track' : 'tracks'}`
            : 'Nothing recorded')}
      </Text>
      <FlatList
        ref={listRef}
        data={items}
        renderItem={renderRow}
        keyExtractor={it => it.trackId}
        extraData={focus}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onLayout={e => {
          visibleRef.current = Math.max(
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
        Recorded while WyM TV is open. A skip from another app shows as stopped.
      </Text>
      <Text style={styles.hint}>
        OK: write to log · ☰ Menu: clear · LEFT/BACK: Settings
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
    paddingBottom: 40,
  },
  heading: {...typeScale.title, color: theme.textPrimary},
  sub: {
    ...typeScale.caption,
    color: theme.textDim,
    marginTop: 2,
    marginBottom: 8,
  },
  list: {flex: 1},
  // Room for the focused row's scale and ring, which the list would clip.
  listContent: {paddingHorizontal: 14, paddingVertical: 4},
  row: {
    height: ROW_H - 6,
    marginBottom: 6,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: radius.md,
    paddingHorizontal: 14,
  },
  title: {...typeScale.body, color: theme.textPrimary},
  detail: {...typeScale.caption, color: theme.textDim, marginTop: 1},
  hint: {
    ...typeScale.caption,
    color: theme.textDim,
    textAlign: 'center',
    marginTop: 4,
  },
});
