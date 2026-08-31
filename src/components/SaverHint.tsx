import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet, Text} from 'react-native';

// A one-line reminder of what the D-pad does while a screensaver is up, shown
// on entry and faded out again a few seconds later.
//
// The keys were undiscoverable: left/right cycle five modes, down returns to
// Now Playing and up deliberately does not, and the menu button toggles the
// progress ring. None of that is guessable from a full-screen visualizer, and
// a permanent legend would spoil the one thing the screen is for.
//
// Deliberately ASCII-only — no arrow glyphs. Fire OS draws ◀ ▶ ▼ from Noto
// Color Emoji, which is exactly what broke text alignment elsewhere in this
// app, and a legend that fades out is not worth a second font.
const HINT_VISIBLE_MS = 5000;
const HINT_FADE_MS = 800;

export default function SaverHint({showsRing = true}: {showsRing?: boolean}) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const timer = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: HINT_FADE_MS,
        useNativeDriver: true,
      }).start();
    }, HINT_VISIBLE_MS);
    Animated.timing(opacity, {
      toValue: 1,
      duration: HINT_FADE_MS,
      useNativeDriver: true,
    }).start();
    return () => clearTimeout(timer);
  }, [opacity]);

  const parts = ['Left / Right  change view', 'Down  back to player'];
  if (showsRing) {
    parts.push('Menu  progress ring');
  }

  return (
    <Animated.View style={[styles.wrap, {opacity}]} pointerEvents="none">
      <Text style={styles.text}>{parts.join('     ·     ')}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    bottom: 28,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  text: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 15,
    letterSpacing: 0.5,
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: {width: 0, height: 1},
    textShadowRadius: 4,
  },
});
