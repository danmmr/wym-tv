import AsyncStorage from '@react-native-async-storage/async-storage';
import {loadHideOverlay, saveHideOverlay} from '../src/store/saverPrefs';

const tick = () => new Promise<void>(r => setImmediate(() => r()));

describe('saver overlay preference', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows the overlay until told otherwise', async () => {
    expect(await loadHideOverlay()).toBe(false);
  });

  it('remembers both choices', async () => {
    saveHideOverlay(true);
    await tick();
    expect(await loadHideOverlay()).toBe(true);
    saveHideOverlay(false);
    await tick();
    expect(await loadHideOverlay()).toBe(false);
  });

  it('shows the overlay when storage fails', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('x'));
    expect(await loadHideOverlay()).toBe(false);
  });
});
