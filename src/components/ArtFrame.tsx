import React, {useEffect, useRef} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  Dimensions,
  Animated,
  Easing,
  NativeModules,
} from 'react-native';
import {usePlayerStore} from '../store/playerStore';
import {DEFAULT_ACCENT} from '../hooks/useAccentColor';

const {width, height} = Dimensions.get('window');

// Digital art frame: a manually triggered, full-screen showcase of the current
// cover art. Deliberately NOT the shader screensaver and deliberately NO clock —
// just the album art presented large and crisp over a soft blurred version of
// itself, with a slow Ken Burns drift, an accent-tinted glow, and the track and
// artist small at the bottom. Entered from the Menu button on Now Playing and
// dismissed on any key (the parent screen owns the D-pad and calls onExit).
export default function ArtFrame() {
  const {albumArt, accent} = usePlayerStore();
  const tint = accent || DEFAULT_ACCENT;

  // Ken Burns: a looping zoom + drift so a static cover never feels dead on the
  // wall. X and Y run on independent oscillators at different periods so the art
  // wanders in a real 2D path instead of sliding along one diagonal line — and
  // the zoom rides its own third cycle. Faster than a lazy drift but still ambient.
  const animX = useRef(new Animated.Value(0)).current;
  const animY = useRef(new Animated.Value(0)).current;
  const animZ = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const pingPong = (val: Animated.Value, duration: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(val, {
            toValue: 1,
            duration,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(val, {
            toValue: 0,
            duration,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ]),
      );
    // Mismatched periods keep the horizontal and vertical drift from ever syncing
    // back into a straight line, so the path stays an organic wander.
    const loops = [
      pingPong(animX, 11000),
      pingPong(animY, 13000),
      pingPong(animZ, 17000),
    ];
    loops.forEach(l => l.start());
    // Keep the screen awake while the frame is showing (same as the screensaver).
    NativeModules.WakeControl?.keepAwake(true);
    return () => {
      loops.forEach(l => l.stop());
      NativeModules.WakeControl?.keepAwake(false);
    };
  }, [animX, animY, animZ]);

  const scale = animZ.interpolate({inputRange: [0, 1], outputRange: [1.06, 1.14]});
  const translateX = animX.interpolate({inputRange: [0, 1], outputRange: [-42, 42]});
  const translateY = animY.interpolate({inputRange: [0, 1], outputRange: [34, -34]});

  // The framed art is a square sized to the screen height so it stays fully on
  // screen with breathing room; the blurred fill behind it hides the letterbox.
  const artSize = Math.min(height - 140, width - 320);

  return (
    <View style={styles.container}>
      {albumArt ? (
        <>
          <Image
            source={{uri: albumArt}}
            style={styles.bg}
            resizeMode="cover"
            blurRadius={40}
          />
          <View style={styles.scrim} pointerEvents="none" />

          <Animated.View
            style={[
              styles.artWrap,
              {
                width: artSize,
                height: artSize,
                shadowColor: tint,
                transform: [{translateX}, {translateY}, {scale}],
              },
            ]}>
            {/* Accent glow: an inflated, tinted panel behind the art. */}
            <View
              style={[
                styles.glow,
                {backgroundColor: tint, shadowColor: tint},
              ]}
            />
            <Image
              source={{uri: albumArt}}
              style={styles.art}
              resizeMode="cover"
            />
          </Animated.View>
        </>
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No album art</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#050505', overflow: 'hidden'},
  bg: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, transform: [{scale: 1.15}]},
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  artWrap: {
    position: 'absolute',
    top: (height - Math.min(height - 140, width - 320)) / 2 - 20,
    alignSelf: 'center',
    borderRadius: 10,
    // A soft drop shadow tinted with the accent gives the framed art depth.
    shadowOffset: {width: 0, height: 0},
    shadowOpacity: 0.9,
    shadowRadius: 40,
    elevation: 24,
  },
  glow: {
    position: 'absolute',
    top: -18,
    left: -18,
    right: -18,
    bottom: -18,
    borderRadius: 20,
    opacity: 0.35,
    shadowOffset: {width: 0, height: 0},
    shadowOpacity: 0.8,
    shadowRadius: 60,
  },
  art: {width: '100%', height: '100%', borderRadius: 10},
  empty: {flex: 1, justifyContent: 'center', alignItems: 'center'},
  emptyText: {color: '#666', fontSize: 24},
});
