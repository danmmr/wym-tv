import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface WiiMDevice {
  id: string;
  ip: string;
  name: string;
  model?: string;
}

// Persist the last-selected device so the app boots straight into Now Playing
// instead of the Discovery screen on every cold start / reinstall.
const SELECTED_KEY = 'wiimtv.selectedDevice';

interface DeviceStore {
  devices: WiiMDevice[];
  selectedDevice: WiiMDevice | null;
  setDevices: (devices: WiiMDevice[]) => void;
  setSelectedDevice: (device: WiiMDevice | null) => void;
  addDevice: (device: WiiMDevice) => void;
  removeDevice: (id: string) => void;
  clearCache: () => void;
}

export const useDeviceStore = create<DeviceStore>((set) => ({
  devices: [],
  selectedDevice: null,
  setDevices: (devices) => set({ devices }),
  setSelectedDevice: (device) => {
    set({ selectedDevice: device });
    if (device) {
      AsyncStorage.setItem(SELECTED_KEY, JSON.stringify(device)).catch(() => {});
    } else {
      AsyncStorage.removeItem(SELECTED_KEY).catch(() => {});
    }
  },
  addDevice: (device) =>
    set((state) => ({
      devices: [...state.devices.filter((d) => d.id !== device.id), device],
    })),
  removeDevice: (id) =>
    set((state) => ({
      devices: state.devices.filter((d) => d.id !== id),
    })),
  clearCache: () => {
    set({ devices: [], selectedDevice: null });
    AsyncStorage.removeItem(SELECTED_KEY).catch(() => {});
  },
}));

// Read the persisted device (if any) into the store. Called once at startup so
// App can pick the initial route. Returns the device, or null if none saved.
export async function loadPersistedDevice(): Promise<WiiMDevice | null> {
  try {
    const raw = await AsyncStorage.getItem(SELECTED_KEY);
    if (!raw) return null;
    const dev = JSON.parse(raw) as WiiMDevice;
    if (!dev || !dev.ip) return null;
    useDeviceStore.setState({ selectedDevice: dev });
    return dev;
  } catch {
    return null;
  }
}
