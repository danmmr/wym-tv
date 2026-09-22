import {create} from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {StationKind} from '../api/plex';

// Persist which station is driving the queue so auto-refill survives an app
// restart / redeploy (JS state is otherwise lost, and a station playing from
// before the restart would stop refilling until re-pressed).
const STATION_KEY = 'wiimtv.stationKind';
const STATION_LABEL_KEY = 'wiimtv.stationLabel';

// A persisted station string is anything we would have written, but it is read
// back from disk and could be left over from an older build — so it is checked
// rather than cast. Style ids are digits: Plex tag keys are numeric, and
// refusing anything else keeps a junk value out of a URL.
function isStationKind(raw: string | null): raw is StationKind {
  return (
    raw === 'library' || raw === 'deepcuts' || /^style:\d+$/.test(raw || '')
  );
}

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
  // Real per-track artist from Plex, used to override `artist` (which comes
  // from the WiiM's queue metadata and reads "Various Artists" on a
  // compilation). Undefined until Plex answers, and whenever the track has no
  // Plex id — the UI falls back to `artist`.
  trackArtist?: string;
  // The Plex album the current track belongs to, so Now Playing's "Album"
  // button can play it. Resolved from the same per-track Plex request that
  // supplies `codec`/`trackArtist`, and cleared on every track change.
  // Undefined whenever the track has no Plex id (line-in, a non-Plex stream) —
  // the button reports that rather than acting.
  albumRef?: {key: string; title: string; artist: string; thumb: string};
  // The "why this?" line under the album title: the album's year and label,
  // and how many albums by this artist the library holds. Same lifecycle as
  // albumRef — from the per-track Plex request, cleared on every track change.
  // artistAlbums and styles each arrive a beat later from their own (cached)
  // request and are undefined until they do, or when Plex could not say.
  context?: {
    year: string;
    label: string;
    artistAlbums?: number;
    styles?: string[];
  };
  // Accent color derived from the current cover art (adaptive theming). Undefined
  // until the art resolves; the UI falls back to the default blue when unset.
  accent?: string; // hex, e.g. "#3b9eff"
  // Which "radio" station is currently driving the queue (for auto-refill), or
  // null when a finite album/lucky queue is playing. Set when a station starts,
  // cleared when any album queue is pushed. A style station carries its Plex
  // tag id in the string itself (`style:259016`) so the refill can rebuild the
  // same query with nothing else to persist.
  stationKind?: StationKind | null;
  // Display name for the running station, e.g. "Drone Radio". Only the tag id
  // is recoverable from stationKind, and re-fetching the style list purely to
  // turn it back into a name would be a network call to render a label.
  stationLabel?: string;
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
  stationLabel: '',
};

export const usePlayerStore = create<PlayerStore>(set => ({
  ...defaultState,
  setPlayerState: state => {
    set(state);
    // Whenever stationKind is explicitly set (station started) or cleared (an
    // album/lucky queue took over), mirror it to disk so it can be restored.
    if ('stationKind' in state) {
      const sk = state.stationKind;
      if (sk) {
        AsyncStorage.setItem(STATION_KEY, sk).catch(() => {});
        AsyncStorage.setItem(STATION_LABEL_KEY, state.stationLabel || '').catch(
          () => {},
        );
      } else {
        AsyncStorage.removeItem(STATION_KEY).catch(() => {});
        AsyncStorage.removeItem(STATION_LABEL_KEY).catch(() => {});
      }
    }
  },
  setAlbumArt: url => set({albumArt: url}),
  clearCache: () => {
    set(defaultState);
    AsyncStorage.removeItem(STATION_KEY).catch(() => {});
    AsyncStorage.removeItem(STATION_LABEL_KEY).catch(() => {});
  },
}));

// Restore the persisted station (if any) into the store at startup so the poll
// loop resumes auto-refilling a station that was playing before the restart.
export async function loadPersistedStation(): Promise<StationKind | null> {
  try {
    const raw = await AsyncStorage.getItem(STATION_KEY);
    if (isStationKind(raw)) {
      const label = (await AsyncStorage.getItem(STATION_LABEL_KEY)) || '';
      usePlayerStore.setState({stationKind: raw, stationLabel: label});
      return raw;
    }
  } catch {}
  return null;
}
