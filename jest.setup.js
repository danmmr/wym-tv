/* eslint-env jest */
// AsyncStorage is a native module, so it throws when required under Jest. The
// package ships an in-memory stand-in; register it globally so any module that
// caches to disk (src/api/plex.ts, the zustand stores) is testable.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
