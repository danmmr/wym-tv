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
import {loadPersistedStation} from './store/playerStore';

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
    loadPersistedDevice()
      .then(dev => setHasDevice(!!dev))
      .finally(() => setBooted(true));
  }, []);

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
