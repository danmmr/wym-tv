import {DeviceEventEmitter, NativeModules} from 'react-native';

// Single owner of the native D-pad stream.
//
// The app captures the D-pad rather than using native TV focus, which draws no
// highlight on Fire OS. Two gaps used to swallow presses whole:
//
//   1. MainActivity.captureDpad started false and was only turned on inside a
//      screen's focus effect, so every press between process start and the
//      first render fell through to native focus and did nothing visible. That
//      window covers the bundle load and the AsyncStorage device read, which is
//      most of a cold start on a Fire Stick. It now starts TRUE natively — the
//      flag is never set back to false anyway, so "off" only ever described the
//      moments before JS was ready.
//   2. Each screen added its own emitter listener on focus and removed it on
//      blur. Between the two, the native side still emitted and there was
//      nobody listening, so presses during a screen transition vanished.
//
// This module fixes (2) by owning ONE listener for the process and routing to
// the most recently focused screen. Screens subscribe and unsubscribe as
// before; the stack means an unsubscribe during a transition falls back to the
// screen underneath rather than to nothing.

type NavHandler = (key: string) => void;

// A stack, not a single slot: react-navigation focuses the incoming screen
// before the outgoing one cleans up in some transitions and after it in
// others. Routing to the TOP is correct either way, and a late unsubscribe
// from the old screen cannot silence the new one.
const handlers: NavHandler[] = [];

// Directional presses made while nothing is subscribed are held briefly and
// handed to the next screen that subscribes, so a press during a transition
// still lands. 'select' and 'menu' are deliberately NOT buffered: replaying an
// activation into a screen the user had not seen yet could start playback or
// navigate somewhere they never chose.
const BUFFERED_KEYS = new Set(['up', 'down', 'left', 'right']);
const BUFFER_MS = 500;

let pending: {key: string; at: number} | null = null;
let now = () => Date.now();

export function dispatchNavKey(key: string): void {
  const top = handlers[handlers.length - 1];
  if (top) {
    // No need to clear `pending` here: subscribeNav always consumes it, so it
    // is already null whenever a handler exists. (A clear was written here
    // first; a mutation test showed nothing could reach it.)
    top(key);
    return;
  }
  pending = BUFFERED_KEYS.has(key) ? {key, at: now()} : null;
}

// Subscribe until the returned function is called. The handler goes on top of
// the stack, so it wins over any screen still mounted underneath.
export function subscribeNav(handler: NavHandler): () => void {
  handlers.push(handler);

  // Hand over a press made during the gap, if it is still fresh. Synchronous
  // on purpose: by the time a focus effect runs, the screen's refs are already
  // populated, so the handler can act on it immediately.
  const held = pending;
  pending = null;
  if (held && now() - held.at <= BUFFER_MS) {
    handler(held.key);
  }

  return () => {
    const i = handlers.lastIndexOf(handler);
    if (i !== -1) {
      handlers.splice(i, 1);
    }
  };
}

// Screens call this on focus. Kept here so the native flag and the JS routing
// are turned on in one place rather than repeated six times.
export function captureDpad(): void {
  NativeModules.RemoteControl?.setCaptureDpad(true);
}

DeviceEventEmitter.addListener('WiiMNavKey', dispatchNavKey);

// Test seam: lets the buffer's expiry be exercised without real waiting.
export function __setClock(fn: () => number): void {
  now = fn;
}
export function __reset(): void {
  handlers.length = 0;
  pending = null;
  now = () => Date.now();
}
