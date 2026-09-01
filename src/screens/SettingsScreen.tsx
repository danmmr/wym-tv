import React, {useCallback, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  NativeModules,
  Alert,
} from 'react-native';
import {version as APP_VERSION} from '../../package.json';
import {color as theme, onArt, type as typeScale} from '../theme';
import {captureDpad, subscribeNav} from '../nav/dpad';
import {useFocusEffect} from '@react-navigation/native';
import {useDeviceStore} from '../store/deviceStore';
import {usePlayerStore} from '../store/playerStore';

// Vertical focus order for the JS D-pad cursor.
const ITEMS = ['device', 'clear', 'restart', 'back'] as const;
type Item = (typeof ITEMS)[number];

export default function SettingsScreen({navigation}: any) {
  const deviceStore = useDeviceStore();
  const playerStore = usePlayerStore();
  const [focusIdx, setFocusIdx] = useState(0);
  const focusIdxRef = useRef(0);

  const setFocus = (idx: number) => {
    focusIdxRef.current = idx;
    setFocusIdx(idx);
  };

  const handleClearCache = () => {
    deviceStore.clearCache();
    playerStore.clearCache();
    Alert.alert('Cache cleared');
  };

  const handleRestart = () => {
    Alert.alert('Restart App', 'Kill and relaunch WyM TV?', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Restart',
        style: 'destructive',
        onPress: () => NativeModules.WakeControl?.restartApp(),
      },
    ]);
  };

  const activate = (item: Item) => {
    if (item === 'device') {
      navigation.navigate('Discovery');
    } else if (item === 'clear') {
      handleClearCache();
    } else if (item === 'restart') {
      handleRestart();
    } else {
      navigation.navigate('NowPlaying');
    }
  };

  // JS-managed focus cursor (native focus is invisible on Fire TV) — same
  // captureDpad + WiiMNavKey pattern as the other screens. Every Pressable
  // below is focusable={false} for the other half of that: native focus is
  // invisible but still LIVE, and DPAD_CENTER clicks whatever holds it, behind
  // this cursor's back. On Now Playing that turned an OK press into a jump to
  // Discovery; here it would fire Clear Cache or Restart.
  // Alert dialogs get their own window, so D-pad works natively inside them.
  useFocusEffect(
    useCallback(() => {
      captureDpad();
      const sub = subscribeNav((k: string) => {
        const idx = focusIdxRef.current;
        if (k === 'up') {
          setFocus(Math.max(0, idx - 1));
        } else if (k === 'down') {
          setFocus(Math.min(ITEMS.length - 1, idx + 1));
        } else if (k === 'select') {
          activate(ITEMS[idx]);
        }
      });
      return sub;
      // The D-pad listener is registered ONCE and reads live values through
      // refs.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const focusedItem = ITEMS[focusIdx];

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      {/* The only remote-reachable way to the device picker. The device name
          on Now Playing opens it too, but that is a touch target on a platform
          with no touch — before this, switching WiiMs meant clearing the cache
          to force the picker at the next start. */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Device</Text>
        <Pressable
          focusable={false}
          style={[styles.button, focusedItem === 'device' && styles.focused]}
          onPress={() => navigation.navigate('Discovery')}>
          <Text style={styles.buttonText}>
            {deviceStore.selectedDevice?.name || 'Choose Device'}
          </Text>
        </Pressable>
        <Text style={styles.aboutText}>
          Pick which WiiM this remote controls.
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Cache</Text>
        <Pressable
          focusable={false}
          style={[styles.button, focusedItem === 'clear' && styles.focused]}
          onPress={handleClearCache}>
          <Text style={styles.buttonText}>Clear Cache</Text>
        </Pressable>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>App</Text>
        <Pressable
          focusable={false}
          style={[styles.button, focusedItem === 'restart' && styles.focused]}
          onPress={handleRestart}>
          <Text style={styles.buttonText}>Restart App</Text>
        </Pressable>
        <Text style={styles.aboutText}>
          Fully kills and relaunches the app, same as force-stopping it in Fire
          TV settings.
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>About</Text>
        {/* One line, not two: the Back line is bottom-pinned, so every line
            About spends is a line closer to it. */}
        <Text style={styles.aboutText}>
          WyM TV v{APP_VERSION} · Remote control for WiiM audio devices
        </Text>
      </View>

      <Pressable
        focusable={false}
        style={styles.backButton}
        onPress={() => navigation.navigate('NowPlaying')}>
        <Text
          style={[
            styles.backButtonText,
            focusedItem === 'back' && styles.backFocusedText,
          ]}>
          ← Back
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 40,
    paddingTop: 20,
    // Overscan-safe bottom inset.
    paddingBottom: 28,
  },
  // Four sections have to fit a 540dp window with no scrolling, so the spacing
  // here is a budget, not taste: the Device section that made it four is what
  // pushed About and the Back line off the bottom at the old 30/15.
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#3b9eff',
    marginBottom: 16,
  },
  section: {
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#3b9eff',
    marginBottom: 8,
  },
  button: {
    backgroundColor: '#ff4444',
    paddingHorizontal: 20,
    paddingVertical: 9,
    borderRadius: 8,
    marginBottom: 10,
    borderWidth: 3,
    borderColor: 'transparent',
    alignSelf: 'flex-start',
    minWidth: 220,
    alignItems: 'center',
  },
  focused: {
    borderColor: '#fff',
  },
  buttonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  aboutText: {
    color: '#aaa',
    fontSize: 15,
    marginBottom: 5,
  },
  // Plain "← Back", matching Browse. The filled blue slab it replaces was
  // full-width and pinned to the bottom, which also meant it overlapped the
  // About text on this screen.
  // Back FLOWS after About rather than being pinned with marginTop:'auto'.
  // Pinned, it printed on top of the About text as soon as the content grew
  // past the 540dp window — 'auto' has no free space left to eat, and nothing
  // here scrolls, so the two just overlapped.
  backButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 4,
    paddingVertical: 8,
    marginTop: 4,
  },
  backButtonText: {
    ...typeScale.label,
    color: theme.textPrimary,
    ...onArt,
  },
  backFocusedText: {
    color: theme.accentFallback,
  },
});
