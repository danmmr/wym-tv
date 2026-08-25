import React, {useEffect} from 'react';
import {StyleSheet} from 'react-native';
import type {ViewStyle} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import {focus as focusTokens, motion} from '../theme';

// Animates a control's focus state.
//
// Focus here is APP-OWNED, not native: nav/dpad.ts captures the D-pad because
// Fire OS draws no highlight of its own, so `focused` arrives as a prop derived
// from focusedKey rather than from a platform focus event.
//
// The old idiom was an instant swap to a 3dp white border plus a static
// transform: scale — no motion at all, which is what made the controls read as
// form fields. Here scale and brightness carry focus and the border is demoted
// to a thin accent ring, present only as a secondary cue.
//
// Both animated properties are transform/opacity, driven by shared values on
// the UI thread. That is the Fire Stick's whole GPU budget: no RN shadow*
// (Android does not GPU-composite it) and no runtime blur.

type Props = {
  focused: boolean;
  children: React.ReactNode;
  /** Focused scale. Lower it for large controls, which magnify more visibly. */
  scale?: number;
  /** Ring colour when focused; pass the art accent to tint with the music. */
  ringColor?: string;
  style?: ViewStyle;
};

export default function Focusable({
  focused,
  children,
  scale = focusTokens.scale,
  ringColor,
  style,
}: Props) {
  const progress = useSharedValue(focused ? 1 : 0);

  useEffect(() => {
    // Scale springs (it should feel physical under a remote); opacity is timed,
    // because a spring on brightness reads as a flicker rather than as motion.
    progress.value = withSpring(focused ? 1 : 0, motion.focusSpring);
  }, [focused, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{scale: 1 + progress.value * (scale - 1)}],
    opacity:
      focusTokens.restOpacity + progress.value * (1 - focusTokens.restOpacity),
  }));

  const ringStyle = useAnimatedStyle(() => ({
    // Timed separately and slightly faster than the spring, so the ring has
    // arrived by the time the scale settles instead of trailing it.
    opacity: withTiming(focused ? 1 : 0, {duration: 120}),
  }));

  return (
    <Animated.View style={[style, animatedStyle]}>
      {children}
      {ringColor ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.ring,
            {
              borderColor: ringColor,
              borderRadius: (style?.borderRadius as number) ?? 0,
            },
            ringStyle,
          ]}
        />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Sits over the control rather than inside it, so adding focus never changes
  // the control's own layout — a border that reserves space would shift every
  // sibling on each D-pad move.
  ring: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: focusTokens.ringWidth,
  },
});
