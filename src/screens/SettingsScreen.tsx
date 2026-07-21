import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  NativeModules,
  DeviceEventEmitter,
  Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useDeviceStore } from '../store/deviceStore';
import { usePlayerStore } from '../store/playerStore';

// Vertical focus order for the JS D-pad cursor.
const ITEMS = ['clear', 'restart', 'back'] as const;
type Item = (typeof ITEMS)[number];

export default function SettingsScreen({ navigation }: any) {
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
    Alert.alert('Restart App', 'Kill and relaunch WiiM TV?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restart',
        style: 'destructive',
        onPress: () => NativeModules.WakeControl?.restartApp(),
      },
    ]);
  };

  const activate = (item: Item) => {
    if (item === 'clear') handleClearCache();
    else if (item === 'restart') handleRestart();
    else navigation.navigate('NowPlaying');
  };

  // JS-managed focus cursor (native TouchableOpacity focus is invisible on
  // Fire TV) — same captureDpad + WiiMNavKey pattern as the other screens.
  // Alert dialogs get their own window, so D-pad works natively inside them.
  useFocusEffect(
    useCallback(() => {
      NativeModules.RemoteControl?.setCaptureDpad(true);
      const sub = DeviceEventEmitter.addListener('WiiMNavKey', (k: string) => {
        const idx = focusIdxRef.current;
        if (k === 'up') setFocus(Math.max(0, idx - 1));
        else if (k === 'down') setFocus(Math.min(ITEMS.length - 1, idx + 1));
        else if (k === 'select') activate(ITEMS[idx]);
      });
      return () => sub.remove();
    }, []),
  );

  const focusedItem = ITEMS[focusIdx];

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Cache</Text>
        <TouchableOpacity
          style={[styles.button, focusedItem === 'clear' && styles.focused]}
          onPress={handleClearCache}>
          <Text style={styles.buttonText}>Clear Cache</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>App</Text>
        <TouchableOpacity
          style={[styles.button, focusedItem === 'restart' && styles.focused]}
          onPress={handleRestart}>
          <Text style={styles.buttonText}>Restart App</Text>
        </TouchableOpacity>
        <Text style={styles.aboutText}>
          Fully kills and relaunches the app, same as force-stopping it in Fire
          TV settings.
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>About</Text>
        <Text style={styles.aboutText}>WiiM TV v0.0.1</Text>
        <Text style={styles.aboutText}>Remote control for WiiM audio devices</Text>
      </View>

      <TouchableOpacity
        style={[styles.backButton, focusedItem === 'back' && styles.focused]}
        onPress={() => navigation.navigate('NowPlaying')}>
        <Text style={styles.backButtonText}>← Back</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    paddingHorizontal: 40,
    paddingVertical: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#3b9eff',
    marginBottom: 30,
  },
  section: {
    marginBottom: 30,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#3b9eff',
    marginBottom: 15,
  },
  button: {
    backgroundColor: '#ff4444',
    paddingHorizontal: 20,
    paddingVertical: 12,
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
    fontSize: 16,
    marginBottom: 8,
  },
  backButton: {
    backgroundColor: '#3b9eff',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 'auto',
    borderWidth: 3,
    borderColor: 'transparent',
  },
  backButtonText: {
    color: '#1a1a1a',
    fontWeight: 'bold',
  },
});
