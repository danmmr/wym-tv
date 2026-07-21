import React, {useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  Animated,
  Easing,
  NativeModules,
} from 'react-native';
import {usePlayerStore} from '../store/playerStore';
import {DEFAULT_ACCENT, accentFor} from '../hooks/useAccentColor';
import {getRandomAlbums, artUrl, PlexAlbum} from '../api/plex';

const {width, height} = Dimensions.get('window');

// Slideshow pacing. Long enough that the frame reads as ambient art rather than
// a carousel; the Ken Burns cycles (11/13/17s) are deliberately shorter so no
// slide is ever shown at a standstill.
const SLIDE_MS = 30000;
const FADE_MS = 1400;
const BATCH = 30;

// Digital art frame: a manually triggered, full-screen showcase of cover art.
// Deliberately NOT the shader screensaver and deliberately NO clock — just the
// art presented large and crisp over a soft blurred version of itself, with a
// slow Ken Burns drift and an accent-tinted glow. Entered from the Menu button
// on Now Playing and dismissed on any key (the parent screen owns the D-pad and
// calls onExit).
//
// Two modes. While something is playing it frames THAT cover. With nothing
// playing it becomes a slideshow over the library, crossfading a new random
// cover every SLIDE_MS — an idle Fire Stick turns into a piece of wall art
// instead of showing an empty screen.
// Drives the library slideshow: holds a shuffled batch of covers, advances one
// every SLIDE_MS, and derives an accent per slide. Returns '' when inactive, so
// the caller falls back to the playing cover.
function useSlideshow(active: boolean) {
  const [slideArt, setSlideArt] = useState('');
  const [slideAccent, setSlideAccent] = useState<string | undefined>();
  const albumsRef = useRef<PlexAlbum[]>([]);
  const idxRef = useRef(0);

  useEffect(() => {
    if (!active) {
      setSlideArt('');
      setSlideAccent(undefined);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const show = async (album: PlexAlbum) => {
      const uri = artUrl(album.thumb, 1000);
      if (cancelled) {
        return;
      }
      setSlideArt(uri);
      // Accent trails the image by a frame or two; that's fine, the glow easing
      // in just after the art lands reads as intentional.
      const a = await accentFor(uri);
      if (!cancelled) {
        setSlideAccent(a);
      }
    };

    const advance = async () => {
      if (cancelled) {
        return;
      }
      // Refill when the batch runs out (or on first run).
      if (idxRef.current >= albumsRef.current.length) {
        try {
          const batch = await getRandomAlbums(BATCH);
          if (cancelled) {
            return;
          }
          albumsRef.current = batch.filter(a => a.thumb);
          idxRef.current = 0;
        } catch {
          // Plex unreachable — retry on the next tick rather than dying.
          albumsRef.current = [];
        }
      }
      const album = albumsRef.current[idxRef.current++];
      if (album) {
        await show(album);
      }
      if (!cancelled) {
        timer = setTimeout(advance, SLIDE_MS);
      }
    };

    advance();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [active]);

  return {slideArt, slideAccent};
}

export default function ArtFrame() {
  const {albumArt, accent, status} = usePlayerStore();

  // While music is actually playing the frame shows THAT cover — it's what you
  // opened it for. Any other state (stopped, or paused an hour ago) means there
  // is nothing to watch, so the frame becomes a slideshow over the library and
  // the Fire Stick turns into wall art. Note this keys off `status`, not off a
  // missing cover: a paused WiiM still reports full track metadata, so testing
  // for "no art" would leave a stale frozen cover up indefinitely.
  const slideshow = status !== 'play';
  const {slideArt, slideAccent} = useSlideshow(slideshow);

  const art = slideshow ? slideArt || albumArt : albumArt;
  const tint = (slideshow ? slideAccent : accent) || DEFAULT_ACCENT;

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

  // Crossfade on slide change: the outgoing cover is held in `fading` and
  // dissolved out underneath the incoming one, so slides never hard-cut.
  const [fading, setFading] = useState('');
  const prevArtRef = useRef('');
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!art || art === prevArtRef.current) {
      return;
    }
    const outgoing = prevArtRef.current;
    prevArtRef.current = art;
    if (!outgoing) {
      return;
    } // first image just appears
    setFading(outgoing);
    fade.setValue(0);
    Animated.timing(fade, {
      toValue: 1,
      duration: FADE_MS,
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: true,
    }).start(({finished}) => {
      if (finished) {
        setFading('');
      }
    });
  }, [art, fade]);

  const scale = animZ.interpolate({
    inputRange: [0, 1],
    outputRange: [1.06, 1.14],
  });
  const translateX = animX.interpolate({
    inputRange: [0, 1],
    outputRange: [-42, 42],
  });
  const translateY = animY.interpolate({
    inputRange: [0, 1],
    outputRange: [34, -34],
  });

  // The framed art is a square sized to the screen height so it stays fully on
  // screen with breathing room; the blurred fill behind it hides the letterbox.
  const artSize = Math.min(height - 140, width - 320);

  return (
    <View style={styles.container}>
      {art ? (
        <>
          {/* Outgoing blurred backdrop, dissolving out under the new one. */}
          {!!fading && (
            <Animated.Image
              source={{uri: fading}}
              style={[
                styles.bg,
                {
                  opacity: fade.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 0],
                  }),
                },
              ]}
              resizeMode="cover"
              blurRadius={40}
            />
          )}
          <Animated.Image
            source={{uri: art}}
            style={[styles.bg, fading ? {opacity: fade} : null]}
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
              style={[styles.glow, {backgroundColor: tint, shadowColor: tint}]}
            />
            {!!fading && (
              <Animated.Image
                source={{uri: fading}}
                style={[
                  styles.art,
                  styles.artStacked,
                  {
                    opacity: fade.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 0],
                    }),
                  },
                ]}
                resizeMode="cover"
              />
            )}
            <Animated.Image
              source={{uri: art}}
              style={[styles.art, fading ? {opacity: fade} : null]}
              resizeMode="cover"
            />
          </Animated.View>
        </>
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {slideshow ? 'Loading library…' : 'No album art'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#050505', overflow: 'hidden'},
  bg: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    transform: [{scale: 1.15}],
  },
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
  // The outgoing cover sits exactly on top of the incoming one during a
  // crossfade, so both occupy the same box inside the drifting wrapper.
  artStacked: {position: 'absolute', top: 0, left: 0},
  empty: {flex: 1, justifyContent: 'center', alignItems: 'center'},
  emptyText: {color: '#666', fontSize: 24},
});
