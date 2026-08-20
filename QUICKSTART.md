# WyM TV — Quick Start

From a fresh clone to music playing on the TV. About 20 minutes, most of it the
first Gradle build.

For the full picture — every screen, every setting, the failure modes — see
[README.md](README.md). This file is only the happy path.

---

## 1. What you need

| | |
| --- | --- |
| **A WiiM / LinkPlay device** | Does the actual playback. WiiM Ultra, Mini, Pro, Amp — anything speaking the LinkPlay HTTP API. |
| **A Plex Media Server** | Serves the library, the artwork and the audio files. Needs a **music** library. |
| **A Fire TV Stick** | Runs this app. ADB debugging must be on (step 3). |
| **A machine to build on** | Node 18-20, Java 17, the Android SDK. Both are ceilings: Node 21+ breaks the RN CLI and Java 18+ breaks Gradle 8. `deploy.sh` finds working versions itself if what you have does not qualify — it does not install them. macOS and Linux both work. |

All three devices must be on the same LAN.

```bash
brew install node@20 openjdk@17
```

The Android SDK is looked for at `~/Library/Android/sdk` (Android Studio's
default on macOS) and `~/Android/Sdk` (its default on Linux). If yours lives
elsewhere, export `ANDROID_SDK_ROOT` and `deploy.sh` will use it. Either way it
puts `platform-tools` — which is where `adb` lives — on the PATH.

---

## 2. Clone and configure

```bash
git clone <this repo> wym-tv && cd wym-tv
npm install
```

`npm install` also creates the two config files you are about to edit, copying
them from the tracked examples. Both are gitignored — one is your network's
layout, the other may hold a Plex token — and the copy only happens when they
are absent, so re-running `npm install` never overwrites your values. (`npm run
setup` does the same thing on demand.)

Until you edit them they hold placeholder addresses: enough for `npm test` and
the typecheck to pass on a clean clone, not enough to reach a real server.
`deploy.sh` stops with instructions rather than building against them.

### `src/config/hosts.data.json` — every LAN address

Edit the copied file. The comments in it explain each key; the values you must
change are:

```jsonc
{
  "plex":     {"host": "192.168.1.10", "port": 32400},
  "wiimDevices": [
    {"ip": "192.168.1.20", "name": "WiiM Ultra", "model": "WiiM_Ultra"}
  ],
  "fireSticks": {
    "primary": "192.168.1.30",              // a bare ./deploy.sh installs here
    "all":    ["192.168.1.30", "192.168.1.31"]
  },
  "scanSubnets": ["192.168.1"]              // /24 prefixes a device scan sweeps
}
```

Give the WiiM units and the sticks **DHCP reservations** on your router. Devices
listed here show up on the Discovery screen instantly, with no network scan.

This one file is the single source of truth: the app imports it, and `deploy.sh`
parses the same JSON, so the two can never disagree about which devices they
mean.

### `src/config/plex.ts` — the library id

Set `musicSection` to the numeric id of your music library. List them at:

```
http://<your-plex-host>:32400/library/sections
```

**Leave the token commented out** unless your server actually requires it. If
Plex allows unauthenticated access on your LAN, it serves metadata, artwork
*and* media parts with no token — and a carried token can only go stale, which
breaks streaming while browsing keeps looking perfectly healthy. `deploy.sh`
tests this for you before every build.

---

## 3. Turn on ADB debugging on the Fire Stick

On the stick: **Settings → My Fire TV → Developer options → ADB debugging: On**.
(If *Developer options* is not there, open **Settings → My Fire TV → About** and
click the device name seven times.)

Note the stick's IP under **Settings → My Fire TV → About → Network**, and put
it in `hosts.data.json` as `fireSticks.primary`.

---

## 4. Build and install

```bash
./deploy.sh
```

That builds a release APK and installs it to the primary stick. The first build
takes several minutes; later ones are much faster.

Before building it also typechecks, runs the unit tests, and range-requests a
real Plex media part to prove the config can *stream* rather than merely browse.
If any of those fail it says exactly what is wrong instead of shipping a build
that skips through every album on the TV.

The first time you run it, **watch the TV**: Fire OS shows an *"Allow USB
debugging?"* prompt that you have to accept, and the deploy cannot proceed until
you do.

Once it works everywhere:

```bash
./deploy.sh all             # every stick in hosts.data.json
./deploy.sh 192.168.1.31    # one specific stick
```

---

## 5. First run

1. The app opens on **Find WiiM Devices**. Units from `hosts.data.json` are
   already listed; **Scan network** finds others.
2. Select your WiiM. That choice is saved, so every later launch boots straight
   into Now Playing.
3. From Now Playing, press **Browse** and play an album.

If nothing is playing yet, Now Playing shows its control grid; **🎲 Feeling
lucky?** is the fastest way to hear something.

---

## 6. The remote, in ten seconds

| Key | Does |
| --- | --- |
| D-pad | Move the focus highlight |
| **OK** | Play the focused album / activate the focused thing |
| **☰ Menu** | On an album: open its track listing. On Now Playing: the art frame. |
| **Back** | Leave the screen or dismiss an overlay |
| Play/Pause, ⏭, ⏮ | Always control the WiiM, on any screen |

In **Browse**, Left from the leftmost column or Up from the top row returns focus
to the tab bar, and Left/Right there switches tabs: Artists, Albums, Recent,
Playlists, Collections, Search.

---

## 7. Playback keeps going without the app

The app never streams audio itself. It pushes a play queue into the WiiM, and
the WiiM pulls the files straight from Plex. You can close the app, unplug the
stick, and the music keeps playing.

---

## If something goes wrong

**Albums rip past, a few seconds each.** Plex is answering 503 on media parts —
almost always a stale token in `src/config/plex.ts`. Comment it out or refresh
it.

**The deploy seemed to change nothing.** The old process survived. `deploy.sh`
force-stops for exactly this reason and warns if the pid did not change; after a
manual install, run `adb shell am force-stop com.wymtv` and relaunch.

**`adb connect` fails, or the device shows as `unauthorized`.** Wake the stick
and accept the debugging prompt on the TV; if it persists,
`adb kill-server && adb start-server`.

**A config value is `undefined` on device but the tests pass.** Module
shadowing — a `.json` or `.js` file sitting next to a `.ts` of the same name.
Metro loads it *before* the `.ts`; Jest does the opposite, so the suite stays
green. Rename the data file to a distinct stem, the way `hosts.data.json` does.
`deploy.sh` fails the build on this.

The [README's troubleshooting section](README.md#troubleshooting) covers the
rest.
