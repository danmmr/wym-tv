// The list behind Settings > Playback Failures, kept on the TV. One row per track
// however often it fails: a bad file on a station comes round again, and the count
// is the useful part, not a row for each time.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {getTrackFile} from '../api/plex';
import type {PlaybackFailure} from './failureWatch';

export interface FailureEntry extends PlaybackFailure {
  file: string; // path on the server, '' when Plex could not say
  count: number;
  lastAt: number;
}

const KEY = 'wym.playbackFailures.v1';
const MAX_ENTRIES = 200;

let entries: FailureEntry[] | null = null;

async function load(): Promise<FailureEntry[]> {
  if (entries) {
    return entries;
  }
  let saved: FailureEntry[] = [];
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    saved = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // An unreadable list starts again rather than breaking playback.
  }
  // Another call may have loaded while this one waited.
  entries = entries || saved;
  return entries;
}

function save(): void {
  AsyncStorage.setItem(KEY, JSON.stringify(entries || [])).catch(() => {});
}

// Newest first.
export async function getFailures(): Promise<FailureEntry[]> {
  return (await load()).slice();
}

export async function recordFailure(
  f: PlaybackFailure,
  now = Date.now(),
): Promise<void> {
  const list = await load();
  const at = list.findIndex(e => e.trackId === f.trackId);
  let entry: FailureEntry;
  if (at >= 0) {
    entry = {...list[at], ...f, count: list[at].count + 1, lastAt: now};
    list.splice(at, 1);
  } else {
    entry = {...f, file: '', count: 1, lastAt: now};
  }
  list.unshift(entry);
  list.length = Math.min(list.length, MAX_ENTRIES);
  save();
  console.log(`[failure] ${describeEntry(entry)}`);
  if (!entry.file) {
    // Saved already, so a failed lookup costs only the path.
    getTrackFile(f.trackId)
      .then(file => {
        if (file) {
          entry.file = file;
          save();
          console.log(`[failure] file: ${file}`);
        }
      })
      .catch(() => {});
  }
}

export async function clearFailures(): Promise<void> {
  entries = [];
  await AsyncStorage.removeItem(KEY).catch(() => {});
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function describeKind(e: PlaybackFailure): string {
  return e.kind === 'load'
    ? "Wouldn't load"
    : `Stopped at ${clock(e.posMs)} of ${clock(e.durMs)}`;
}

export function describeEntry(e: FailureEntry): string {
  return [
    describeKind(e),
    `${e.artist} - ${e.album} - ${e.title}`,
    `x${e.count}`,
    e.file || e.trackId,
  ].join(' | ');
}

// Reading a long list off a TV is no way to work through it, so this writes it to
// logcat, where `adb logcat -s ReactNativeJS` can collect it.
export async function dumpFailures(): Promise<number> {
  const list = await load();
  list.forEach(e => console.log(`[failure] ${describeEntry(e)}`));
  return list.length;
}
