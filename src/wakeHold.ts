// The one owner of the screen-awake flag: held whenever the WiiM is PLAYING,
// on every screen, released when it pauses or stops.
//
// It used to be held only by the app's own screensaver (Screensaver.tsx and
// ArtFrame.tsx). Any state that kept that saver from coming up — a screen or
// overlay where the 2-minute idle timer never fired it — left nothing holding
// the screen, so after Fire OS's own 5-minute timeout its ambient screensaver
// took over. That backgrounds this app, and App.tsx exits on background, so
// from the couch it looked like a crash. Measured on a stick on 2026-09-24:
// last key 16:59:36, Fire OS "Entering dreamland" at 17:04:36 exactly, app
// EXIT_SELF one second later, music playing throughout.
//
// Single owner on purpose. With a hold in each saver, a saver unmounting ran
// keepAwake(false) and cleared the flag for everyone — so any second holder
// would be silently cancelled whenever the saver closed.

type Status = string;

export function startWakeHold(
  subscribe: (listener: (status: Status) => void) => () => void,
  initial: Status,
  keepAwake: (enable: boolean) => void,
): () => void {
  let held = initial === 'play';
  keepAwake(held);
  const unsubscribe = subscribe(status => {
    const want = status === 'play';
    // The poll writes the status every 1.5s; only a CHANGE reaches native.
    if (want !== held) {
      held = want;
      keepAwake(want);
    }
  });
  return () => {
    unsubscribe();
    keepAwake(false);
  };
}
