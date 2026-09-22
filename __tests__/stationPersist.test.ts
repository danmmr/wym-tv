// A station has to survive a restart. JS state is lost on a redeploy or an app
// kill, and a station that was playing before would then stop auto-refilling
// with no symptom until its queue simply ran out.
//
// Style stations raise the stakes: the whole station is the tag id inside
// `stationKind`, so a persisted value that comes back mangled does not fail —
// it refills as a DIFFERENT station, or as no filter at all, which is the
// full library wearing the wrong name.

jest.mock('../src/config/plex', () => ({
  PLEX: {baseUrl: 'http://plex.test:32400', musicSection: 4},
}));

const AsyncStorage = require('@react-native-async-storage/async-storage');

type StoreApi = typeof import('../src/store/playerStore');

function loadStore(): StoreApi {
  let mod!: StoreApi;
  jest.isolateModules(() => {
    mod = require('../src/store/playerStore');
  });
  return mod;
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('station persistence', () => {
  it('restores a style station with its tag id intact', async () => {
    const a = loadStore();
    a.usePlayerStore.getState().setPlayerState({
      stationKind: 'style:259016',
      stationLabel: 'Abstract Radio',
    });

    // A restart: fresh module state, same disk.
    const b = loadStore();
    expect(b.usePlayerStore.getState().stationKind).toBeNull();
    await expect(b.loadPersistedStation()).resolves.toBe('style:259016');
    expect(b.usePlayerStore.getState().stationKind).toBe('style:259016');
    expect(b.usePlayerStore.getState().stationLabel).toBe('Abstract Radio');
  });

  it('still restores the two fixed stations', async () => {
    for (const kind of ['library', 'deepcuts'] as const) {
      await AsyncStorage.clear();
      const a = loadStore();
      a.usePlayerStore.getState().setPlayerState({stationKind: kind});
      await expect(loadStore().loadPersistedStation()).resolves.toBe(kind);
    }
  });

  it('refuses a stored value that is not a station', async () => {
    // Left over from an older build, or a truncated write. Anything that is not
    // recognised must restore as "no station" rather than reach a Plex query.
    for (const junk of ['style:', 'style:abc', 'style', 'radio', '', 'null']) {
      await AsyncStorage.setItem('wiimtv.stationKind', junk);
      const s = loadStore();
      await expect(s.loadPersistedStation()).resolves.toBeNull();
      expect(s.usePlayerStore.getState().stationKind).toBeNull();
    }
  });

  it('forgets the station when an album queue takes over', async () => {
    const a = loadStore();
    a.usePlayerStore
      .getState()
      .setPlayerState({stationKind: 'style:650', stationLabel: 'Drone Radio'});
    a.usePlayerStore.getState().setPlayerState({stationKind: null});
    await expect(loadStore().loadPersistedStation()).resolves.toBeNull();
    await expect(
      AsyncStorage.getItem('wiimtv.stationLabel'),
    ).resolves.toBeNull();
  });
});

// This file is a module, not a global script: two suites declaring the same
// top-level const would otherwise collide under tsc (jest never sees it).
export {};
