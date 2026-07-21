import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  DeviceEventEmitter,
  NativeModules,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useDeviceStore } from '../store/deviceStore';
import { DeviceDiscovery } from '../api/discovery';
import { WiiMDevice } from '../store/deviceStore';
import { KNOWN_DEVICES } from '../config/knownDevices';

export default function DiscoveryScreen({ navigation }: any) {
  // Seed with the known/hardcoded devices so they appear instantly.
  const [devices, setDevices] = useState<WiiMDevice[]>(KNOWN_DEVICES);
  const [loading, setLoading] = useState(false);
  const [manualIP, setManualIP] = useState('');
  const [manualError, setManualError] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);
  const { setSelectedDevice } = useDeviceStore();

  // D-pad focus ring: each device, then the Scan button.
  const items = [...devices.map((d) => d.id), 'scan'];
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const focusIdxRef = useRef(0);
  const focusedId = items[Math.min(focusIdx, items.length - 1)];

  // No auto-scan — the known devices are shown immediately. Use "Scan network"
  // to discover anything not in the hardcoded list.

  const discoverDevices = async () => {
    setLoading(true);
    try {
      const discovery = new DeviceDiscovery();
      // Stream newly-found devices in, keeping the known ones already shown.
      await discovery.discover((d) => {
        setDevices((prev) =>
          prev.find((x) => x.id === d.id) ? prev : [...prev, d],
        );
      });
    } catch (error) {
      console.error('Discovery error:', error);
    }
    setLoading(false);
  };

  const addManual = async () => {
    const ip = manualIP.trim();
    if (!ip) return;
    setManualError('');
    setLoading(true);
    try {
      const discovery = new DeviceDiscovery();
      const device = await discovery.probeOne(ip);
      if (device) {
        setDevices((prev) =>
          prev.find((x) => x.id === device.id) ? prev : [...prev, device],
        );
        setManualIP('');
      } else {
        setManualError(`No WiiM device responded at ${ip}`);
      }
    } catch (e) {
      setManualError(`Could not reach ${ip}`);
    }
    setLoading(false);
  };

  const selectDevice = (device: WiiMDevice) => {
    setSelectedDevice(device);
    navigation.navigate('NowPlaying');
  };

  const activate = (id: string) => {
    if (id === 'scan') {
      discoverDevices();
      return;
    }
    const dev = devices.find((d) => d.id === id);
    if (dev) selectDevice(dev);
  };

  React.useEffect(() => {
    focusIdxRef.current = focusIdx;
  }, [focusIdx]);

  // Own the D-pad while this screen is focused; render a visible focus cursor.
  useFocusEffect(
    useCallback(() => {
      NativeModules.RemoteControl?.setCaptureDpad(true);
      setFocusIdx((i) => Math.min(i, itemsRef.current.length - 1));
      const sub = DeviceEventEmitter.addListener('WiiMNavKey', (k: string) => {
        const len = itemsRef.current.length;
        if (k === 'up') {
          setFocusIdx((i) => Math.max(0, i - 1));
        } else if (k === 'down') {
          setFocusIdx((i) => Math.min(len - 1, i + 1));
        } else if (k === 'select') {
          activate(itemsRef.current[focusIdxRef.current]);
        }
      });
      // Don't unset capture on blur — the next screen sets what it needs on
      // focus (avoids a focus/blur ordering race on the shared flag).
      return () => {
        sub.remove();
      };
    }, [devices]),
  );

  const renderDevice = ({ item }: { item: WiiMDevice }) => (
    <TouchableOpacity
      style={[
        styles.deviceCard,
        focusedId === item.id && styles.deviceCardFocused,
      ]}
      onPress={() => selectDevice(item)}
      activeOpacity={0.7}>
      <Text style={styles.deviceName}>{item.name}</Text>
      <Text style={styles.deviceInfo}>IP: {item.ip}</Text>
      {item.model && <Text style={styles.deviceModel}>{item.model}</Text>}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Find WiiM Devices</Text>

      {/* Manual add-by-IP — always available as a reliable fallback */}
      <View style={styles.manualRow}>
        <TextInput
          style={styles.manualInput}
          value={manualIP}
          onChangeText={setManualIP}
          placeholder="Enter WiiM IP (e.g. 192.168.2.50)"
          placeholderTextColor="#666"
          keyboardType="numeric"
          autoCapitalize="none"
          onSubmitEditing={addManual}
        />
        <TouchableOpacity style={styles.manualButton} onPress={addManual}>
          <Text style={styles.manualButtonText}>Add</Text>
        </TouchableOpacity>
      </View>
      {manualError ? <Text style={styles.errorText}>{manualError}</Text> : null}

      <FlatList
        data={devices}
        renderItem={renderDevice}
        keyExtractor={(item) => item.id}
        extraData={focusedId}
        style={styles.list}
      />

      <TouchableOpacity
        style={[
          styles.scanButton,
          focusedId === 'scan' && styles.scanButtonFocused,
        ]}
        onPress={discoverDevices}
        disabled={loading}>
        {loading ? (
          <ActivityIndicator size="small" color="#1a1a1a" />
        ) : (
          <Text style={styles.scanButtonText}>Scan network for more</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a1a',
    // Fire TV overscan-safe insets (matches NowPlayingScreen): big bottom inset
    // keeps the bottom Scan button clear of this TV's ~10%+ bottom crop.
    paddingHorizontal: 48,
    paddingTop: 30,
    paddingBottom: 140,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#3b9eff',
    marginBottom: 20,
  },
  manualRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  manualInput: {
    flex: 1,
    backgroundColor: '#2a2a2a',
    color: '#fff',
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    marginRight: 10,
  },
  manualButton: {
    backgroundColor: '#3b9eff',
    paddingHorizontal: 28,
    justifyContent: 'center',
    borderRadius: 8,
  },
  manualButtonText: {
    color: '#1a1a1a',
    fontSize: 16,
    fontWeight: 'bold',
  },
  errorText: {
    color: '#ff6666',
    fontSize: 14,
    marginBottom: 8,
  },
  scanButton: {
    backgroundColor: '#2a2a2a',
    borderWidth: 3,
    borderColor: '#3b9eff',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  scanButtonFocused: {
    borderColor: '#ffffff',
    backgroundColor: '#16315a',
  },
  scanButtonText: {
    color: '#3b9eff',
    fontSize: 15,
    fontWeight: 'bold',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#fff',
    fontSize: 18,
    marginTop: 20,
  },
  list: {
    flex: 1,
  },
  deviceCard: {
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    padding: 20,
    marginBottom: 15,
    borderLeftWidth: 4,
    borderLeftColor: '#3b9eff',
    borderWidth: 3,
    borderColor: 'transparent',
  },
  deviceCardFocused: {
    borderColor: '#ffffff',
    backgroundColor: '#16315a',
  },
  deviceName: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#3b9eff',
    marginBottom: 8,
  },
  deviceInfo: {
    fontSize: 16,
    color: '#aaa',
    marginBottom: 4,
  },
  deviceModel: {
    fontSize: 14,
    color: '#888',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: '#aaa',
    fontSize: 18,
    marginBottom: 20,
  },
  refreshButton: {
    backgroundColor: '#3b9eff',
    paddingHorizontal: 40,
    paddingVertical: 15,
    borderRadius: 8,
  },
  refreshButtonText: {
    color: '#1a1a1a',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
