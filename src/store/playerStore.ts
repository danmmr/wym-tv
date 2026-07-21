import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Persist which station is driving the queue so auto-refill survives an app
// restart / redeploy (JS state is otherwise lost, and a station playing from
// before the restart would stop refilling until re-pressed).
const STATION_KEY = 'wiimtv.stationKind';

export interface PlayerState {
  status: 'play' | 'pause' | 'stop';
  title: string;
  artist: string;
  album: string;
  albumArt?: string;
  currentPos: number;
  duration: number;
  volume: number;
  mute: boolean;
  mode: string;
  inputMode?: string;
  sampleRate?: string; // Hz, e.g. "44100"
  bitDepth?: string; // bits, e.g. "16"
  bitRate?: string; // kbps, e.g. "320"
  codec?: string; // display label from Plex, e.g. "FLAC" / "ALAC" / "MP3"
  // Accent color derived from the current cover art (adaptive theming). Undefined
  // until the art resolves; the UI falls back to the default blue when unset.
  accent?: string; // hex, e.g. "#3b9eff"
  // Which "radio" station is currently driving the queue (for auto-refill), or
  // null when a finite album/lucky queue is playing. Set when a station starts,
  // cleared when any album queue is pushed.
  stationKind?: 'library' | 'deepcuts' | null;
}

interface PlayerStore extends PlayerState {
  setPlayerState: (state: Partial<PlayerState>) => void;
  setAlbumArt: (url: string) => void;
  clearCache: () => void;
}

const defaultState: PlayerState = {
  status: 'stop',
  title: 'No track playing',
  artist: 'Unknown artist',
  album: 'Unknown album',
  albumArt: undefined,
  currentPos: 0,
  duration: 0,
  volume: 60,
  mute: false,
  mode: 'unknown',
  stationKind: null,
};

export const usePlayerStore = create<PlayerStore>((set) => ({
  ...defaultState,
  setPlayerState: (state) => {
    set(state);
    // Whenever stationKind is explicitly set (station started) or cleared (an
    // album/lucky queue took over), mirror it to disk so it can be restored.
    if ('stationKind' in state) {
      const sk = state.stationKind;
      if (sk) {
        AsyncStorage.setItem(STATION_KEY, sk).catch(() => {});
      } else {
        AsyncStorage.removeItem(STATION_KEY).catch(() => {});
      }
    }
  },
  setAlbumArt: (url) => set({ albumArt: url }),
  clearCache: () => {
    set(defaultState);
    AsyncStorage.removeItem(STATION_KEY).catch(() => {});
  },
}));

// Restore the persisted station (if any) into the store at startup so the poll
// loop resumes auto-refilling a station that was playing before the restart.
export async function loadPersistedStation(): Promise<
  'library' | 'deepcuts' | null
> {
  try {
    const raw = await AsyncStorage.getItem(STATION_KEY);
    if (raw === 'library' || raw === 'deepcuts') {
      usePlayerStore.setState({ stationKind: raw });
      return raw;
    }
  } catch {}
  return null;
}
