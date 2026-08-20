/**
 * Smoke test for the REAL app tree (src/App), not the react-native template
 * file that used to sit at the repo root. It boots with no persisted device,
 * so it renders the navigator's Discovery route — the cold-start path.
 *
 * @format
 */

import 'react-native';
import React from 'react';
import {act, create} from 'react-test-renderer';

// Native modules the screens pull in. None of them have a JS implementation
// under jest, so they are stubbed to the shape the app actually consumes.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
  removeItem: jest.fn(async () => {}),
}));

// reanimated's shipped mock is untranspiled TypeScript, so stub it directly.
// Unknown exports become no-ops; nothing here is exercised until a screen that
// animates actually renders.
jest.mock('react-native-reanimated', () => {
  const {View} = require('react-native');
  const target: any = {
    __esModule: true,
    default: {
      View,
      Text: View,
      ScrollView: View,
      createAnimatedComponent: (c: any) => c,
    },
    useSharedValue: (v: any) => ({value: v}),
    useDerivedValue: () => ({value: 0}),
    useAnimatedStyle: () => ({}),
    useFrameCallback: () => ({setActive: () => {}}),
    runOnUI: (fn: any) => fn,
    runOnJS: (fn: any) => fn,
    withTiming: (v: any) => v,
    withRepeat: (v: any) => v,
    Easing: {linear: () => 0, inOut: () => 0, ease: () => 0},
  };
  return new Proxy(target, {
    get: (t, key) => (key in t ? t[key as string] : () => {}),
  });
});

jest.mock('react-native-image-colors', () => ({
  getColors: jest.fn(async () => ({platform: 'android', vibrant: '#3b9eff'})),
}));

// Skia ships ESM that jest will not parse, and Screensaver compiles four
// shaders at import time, so the stub has to actually return something from
// RuntimeEffect.Make. Any other named export becomes a host component.
jest.mock('@shopify/react-native-skia', () => {
  const React = require('react');
  const componentFor = (name: string) => {
    const C = ({children}: any) =>
      React.createElement(name, null, children ?? null);
    C.displayName = name;
    return C;
  };
  const target: any = {
    __esModule: true,
    Skia: {
      RuntimeEffect: {Make: () => ({})},
      Path: {Make: () => ({addCircle: () => {}, close: () => {}})},
      Data: {fromBytes: () => ({})},
      Image: {MakeImageFromEncoded: () => ({})},
      PaintStyle: {Stroke: 1, Fill: 0},
    },
  };
  return new Proxy(target, {
    get: (t, key) => (key in t ? t[key as string] : componentFor(String(key))),
  });
});

// The config is gitignored, so a fresh clone has no src/config/plex.ts to
// import — and mocking it keeps a real token out of failure output.
jest.mock('../src/config/plex', () => ({
  PLEX: {
    baseUrl: 'http://plex.test:32400',
    token: '',
    musicSection: 4,
  },
}));

import App from '../src/App';

it('boots into Discovery when no device is persisted', async () => {
  let tree: ReturnType<typeof create> | undefined;

  await act(async () => {
    tree = create(<App />);
  });

  // The boot effect resolves before the navigator renders, so reaching this
  // point at all means the real screen tree mounted without throwing.
  const rendered = JSON.stringify(tree!.toJSON());
  expect(rendered).toContain('Find WiiM Devices');
});
