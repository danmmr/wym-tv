import AsyncStorage from '@react-native-async-storage/async-storage';

// Whether the screensaver hides the floating album art and text, toggled with
// Up while the saver is showing and remembered across launches.
const HIDE_KEY = 'saver_hide_overlay';

export async function loadHideOverlay(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(HIDE_KEY)) === '1';
  } catch {
    return false;
  }
}

export function saveHideOverlay(hide: boolean): void {
  AsyncStorage.setItem(HIDE_KEY, hide ? '1' : '0').catch(() => {});
}
