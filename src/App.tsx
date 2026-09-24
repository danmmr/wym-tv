import React, {useEffect, useState} from 'react';
import {AppState, NativeModules} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import DiscoveryScreen from './screens/DiscoveryScreen';
import NowPlayingScreen from './screens/NowPlayingScreen';
import BrowseScreen from './screens/BrowseScreen';
import QueueScreen from './screens/QueueScreen';
import AlbumScreen from './screens/AlbumScreen';
import SettingsScreen from './screens/SettingsScreen';
import {loadPersistedDevice} from './store/deviceStore';
import {loadPersistedStation, usePlayerStore} from './store/playerStore';
import {warmStyles} from './api/plex';
import {startWakeHold} from './wakeHold';

const Stack = createNativeStackNavigator();

export default function App() {
  // Hydrate the saved device before rendering the navigator so we can boot
  // straight into Now Playing when one is remembered (skip Discovery).
  const [booted, setBooted] = useState(false);
  const [hasDevice, setHasDevice] = useState(false);

  useEffect(() => {
    // Restore the station flag alongside the device so a station that was
    // driving the queue before a restart keeps auto-refilling.
    loadPersistedStation().catch(() => {});
    // Warm the Style Radio list in the background. Deferred rather than fired
    // here: on a cold cache it is a few hundred small requests, and the first
    // seconds of a launch already belong to hydrating the device, connecting to
    // the WiiM and the first poll. Nothing waits on this, so it can wait.
    const styleWarm = setTimeout(warmStyles, 4000);
    loadPersistedDevice()
      .then(dev => setHasDevice(!!dev))
      .finally(() => setBooted(true));
    return () => clearTimeout(styleWarm);
  }, []);

  // Keep the TV awake while music plays, on every screen. See wakeHold.ts for
  // why this is app-wide and the only holder: without it, Fire OS's own
  // screensaver backgrounds the app, and the effect below then exits it.
  useEffect(
    () =>
      startWakeHold(
        l => usePlayerStore.subscribe(s => l(s.status)),
        usePlayerStore.getState().status,
        on => NativeModules.WakeControl?.keepAwake(on),
      ),
    [],
  );

  // Fully exit when the app leaves the foreground (Home pressed, another app
  // taken over) so it holds zero CPU/GPU/memory on the resource-tight Fire
  // Stick while not in use. Playback is unaffected — the WiiM plays its native
  // PlayQueue straight from Plex, independent of this app; relaunch is a cold
  // start back into Now Playing. Only 'background' triggers it, not the
  // transient 'inactive' state (in-app dialogs keep the activity resumed).
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background') {
        NativeModules.WakeControl?.exitApp();
      }
    });
    return () => sub.remove();
  }, []);

  if (!booted) {
    return null;
  } // brief; the native splash covers this

  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName={hasDevice ? 'NowPlaying' : 'Discovery'}
        screenOptions={{
          headerShown: false,
          animation: 'default',
        }}>
        <Stack.Screen
          name="Discovery"
          component={DiscoveryScreen}
          options={{title: 'Find Devices'}}
        />
        <Stack.Screen
          name="NowPlaying"
          component={NowPlayingScreen}
          options={{title: 'Now Playing'}}
        />
        <Stack.Screen
          name="Browse"
          component={BrowseScreen}
          options={{title: 'Browse'}}
        />
        <Stack.Screen
          name="Album"
          component={AlbumScreen}
          options={{title: 'Album'}}
        />
        <Stack.Screen
          name="Queue"
          component={QueueScreen}
          options={{title: 'Queue'}}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{title: 'Settings'}}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
