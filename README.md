# WyM TV

A Fire TV remote and browser for WiiM audio devices, backed by a local Plex music library.

WyM TV (package `com.wymtv`, display name **WyM TV**) is a React Native 0.73 app built for the Amazon Fire TV Stick. It shows what a WiiM unit is playing, controls it, and lets you browse the Plex music library on a TV screen with the Fire TV remote. Playback itself never runs on the stick: the app pushes a native **play queue** into the WiiM over UPnP, and the WiiM streams the files straight from Plex. The app can be closed at any time and the music keeps going.

- Deploy: `./deploy.sh`
- Requires: a WiiM/LinkPlay device, a Plex Media Server with a music library, and a Fire TV Stick with ADB debugging enabled, all on the same LAN.
- License: [MIT](LICENSE) (code) · [CC BY 4.0](src/assets/LICENSE) (the landing photo)

### From a fresh clone

```bash
npm install                 # also creates the two config files from their examples
$EDITOR src/config/hosts.data.json   # your LAN addresses
./deploy.sh                 # build + install
```

`npm install` runs `scripts/setup-config.js`, which copies `hosts.data.example.json` and `plex.example.ts` into place as the gitignored `hosts.data.json` and `plex.ts` — but only when they do not already exist, so it never overwrites your values. That means a clean clone typechecks, lints and passes its tests immediately; the placeholder addresses just do not point at a real Plex server, and `deploy.sh` refuses to build against them. Run it again any time with `npm run setup`.

See [Configuration](#configuration) for what goes in them.

Requires Node 18-20 and Java 17 — both are version *ceilings*: the React Native 0.73 CLI breaks on Node 21+, and Gradle 8.x will not build with a newer JDK. `deploy.sh` finds a qualifying Node and JDK itself if the ones on your PATH do not qualify, and tells you what to install if it cannot.

New here? **[QUICKSTART.md](QUICKSTART.md)** walks the whole path from clone to music on the TV. This README is the reference.

---

## Contents

1. [How it works](#how-it-works)
2. [Remote control key map](#remote-control-key-map)
3. [Screens](#screens)
4. [Feature reference](#feature-reference)
5. [Configuration](#configuration)
6. [Build, test and deploy](#build-test-and-deploy)
7. [Troubleshooting](#troubleshooting)
8. [Architecture notes](#architecture-notes)

---

## How it works

Three boxes, and the app is only one of them:

| Box | Role |
| --- | --- |
| Fire TV Stick | Runs WyM TV: the UI, the browsing, the queue building |
| WiiM device | Holds the play queue and does the actual playback |
| Plex Media Server | Serves the library metadata, the cover art and the audio files |

The app talks to the WiiM over two interfaces: the LinkPlay HTTP API (`https://<ip>/httpapi.asp?command=...`) for transport, volume, status and presets, and the WiiMu **PlayQueue** UPnP/SOAP service (`http://<ip>:49152/upnp/control/PlayQueue1`) for creating, appending to and jumping within the queue.

Every queue the app creates is pushed under one fixed name, `WiiMTV` (shown in the UI as "WyM TV"). Anything the WiiM is playing that carries a different queue name came from another app, such as WiiM Home.

Plex is read directly over HTTP as JSON. The app never proxies audio: it hands the WiiM full stream URLs and steps out of the way.

---

## Remote control key map

The app captures the D-pad itself and draws its own focus highlight, because native TV focus draws nothing visible on Fire OS. Media/transport keys on the remote are always forwarded, regardless of screen.

| Remote key | Emits | Meaning |
| --- | --- | --- |
| D-pad up/down/left/right | `WiiMNavKey` | Move the focus cursor |
| OK / center / Enter | `WiiMNavKey: select` | Activate the focused item |
| ☰ Menu / Options | `WiiMNavKey: menu` | Context action (see per screen below) |
| Back | hardware back | Leave the current screen or dismiss an overlay |
| Play/Pause | `WiiMRemoteKey: playPause` | Play/pause on the WiiM |
| Fast-forward / Next | `WiiMRemoteKey: next` | Next track |
| Rewind / Previous | `WiiMRemoteKey: prev` | Previous track |

Media keys work on Now Playing even when the screensaver or art frame is up (the overlay is dismissed first).

---

## Screens

### Discovery (`Find WiiM Devices`)

The first screen on a fresh install. Afterwards the app boots straight into Now Playing, because the selected device is persisted.

- The WiiM units listed in `hosts.data.json` appear **instantly**, with no scan.
- **Scan network** sweeps the configured `/24` subnets, hosts 1 to 254, in bounded batches of 32 probes, stopping at the first subnet that yields a device. Found devices stream in as they answer.
- **Add by IP** probes a single address, for a unit that is not in the config and not on a scanned subnet.
- Selecting a device saves it and goes to Now Playing. Reopen this screen any time by pressing the device name in the Now Playing header.

### Now Playing

The home screen. Blurred cover art fills the background, and the whole UI tints to an accent colour derived from that art.

Displayed:

- Title, artist and album. The artist shown is the **real per-track credit** from Plex when available, which is what makes compilations read correctly instead of saying "Various Artists" on every track.
- A quality badge and a format line, for example `HI-RES` or `LOSSLESS` next to `FLAC · 16-bit · 44.1 kHz · 1008 kbps`. Codec comes from Plex; bit depth, sample rate and bitrate come from the WiiM.
- Elapsed/total time with a progress bar, and a volume bar.
- A status line echoing the last action taken.
- An amber `⟳ reconnecting…` marker when the WiiM has missed two consecutive polls.

Control grid (D-pad moves within and between rows):

| Row | Buttons |
| --- | --- |
| 1 | ⏮ Prev, ▶ Play / ⏸ Pause, Next ⏭ |
| 2 | 🔉 volume down, 🔊 volume up (5% per press) |
| 3 | 🎲 Feeling lucky?, ☰ Queue |
| 4 | 📻 Library Radio, 🌊 Deep Cuts |
| 5 | Recently Added, 💿 Album |
| 6 | Browse, Settings, Screensaver |

The ☰ Menu key from this screen opens the **digital art frame**.

### Browse

A tab bar across the top, content below, and a Back item at the bottom. Left from the leftmost column, or Up from the top row, returns focus to the tab bar; left/right on the tab bar switches tabs.

| Tab | Content |
| --- | --- |
| **Artists** | Grid of artists (thumbnail, name, album count). OK drills into that artist's releases, oldest first. Left or Up from the releases grid returns to the roster, on the same card you left from. |
| **Albums** | Grid of album covers. OK plays the album from track 1. |
| **Recent** | Most recently *added* albums, newest first, with a **Shuffle** button above the grid (Up from the top row) that plays a shuffled queue of recent tracks. Never cached, so a fresh import shows up immediately. |
| **Playlists** | All audio playlists, alphabetical, with track counts and a `smart` marker. OK plays the playlist in its stored order. |
| **Collections** | Grid of the library's album collections (composite cover, title, album count, `⚙` for a smart one). OK drills into that collection's albums, in the server's stored order. Left or Up from the album grid returns to the collections, on the same card you left from. |
| **Search** | On-screen A-Z keyboard on the left (plus SPACE, DEL, CLEAR), matching albums on the right. Matches album title **or** artist, case-insensitive substring, across the entire catalog. Right from the keyboard crosses into the results; Left goes back. |
| **Presets** | The WiiM's own six stored presets. Hidden by default. |
| **Inputs** | The WiiM's physical/streaming input sources. Hidden by default. |

Pressing **☰ Menu** on any focused album (Albums, Recent, an artist's releases, a collection's albums, or a search result) opens the album's track listing instead of playing it. OK stays the one-keypress "just play this album" action.

The Albums grid and the Artists roster are bounded **samples** of 500 items each, not the whole library. With random order on (the default) that is a fresh random draw per session; with it off it is the first 500 alphabetically. The cap is display-only: Search still covers the complete catalog, so nothing in the library is unreachable.

### Album (track listing)

Reached with ☰ from Browse. Shows the cover, album artist, track count and total runtime, then the numbered track list with durations. A per-track artist is shown only when it differs from the album artist, which is what makes a compilation readable.

OK on a track plays the album **starting at that track**; the whole album still goes to the WiiM as one queue, so the rest plays on afterwards. Left or Back returns to Browse.

### Queue

The WiiM's current play queue, read back off the device.

- The header names the queue (`WyM TV` for queues this app pushed, otherwise whatever the originating app called it).
- The playing track is marked `▶` and the highlight refreshes every 4 seconds as the queue advances.
- OK on a track jumps the WiiM to that position.
- The top item is a **shuffle toggle** (LinkPlay loop mode 3 shuffle / 4 sequence).
- Left or Back returns to Now Playing.

### Settings

- **Clear Cache**: forgets the selected device, the player state and the persisted station.
- **Restart App**: a real process restart (new activity task, then `exit(0)`), equivalent to a Fire TV force-stop and relaunch. Use it when native state is stuck (UPnP sockets, GPU context), which a JS reload does not clear.
- **About**: version and description.

### Screensaver

Opens automatically after **2 minutes** of no key presses on Now Playing, or on demand from the Screensaver footer button.

Full-screen GPU shader visualizer, the album art floating over it, the current time, and the track title/artist. The shader palette follows the album art's accent hue, so the field stays in that album's colour family. The screen is kept awake while it is up.

While the screensaver is showing:

| Key | Action |
| --- | --- |
| Left | Plasma |
| Right | Flow |
| Up | Starfield / warp tunnel |
| Down | Metaball / lava lamp |
| ☰ Menu | Toggle the song-progress ring around the album art (off by default) |
| OK, Back, anything else | Return to Now Playing |

### Digital art frame

Opened with **☰ Menu** from Now Playing. Deliberately not the screensaver: no shader, no clock, just the cover art presented large and crisp over a soft blurred copy of itself, with a slow Ken Burns drift and an accent-tinted glow.

Two modes: while something is playing it frames that cover; with nothing playing it becomes a library slideshow, crossfading a new random cover every 30 seconds. Any key dismisses it. The shader screensaver is suppressed while the art frame is up, and re-arms when it is dismissed.

---

## Feature reference

### Feeling lucky

Picks one random album from the library and plays it from track 1. If Browse has already loaded the catalog the pick is instant; otherwise it is a single `sort=random&size=1` request to Plex.

### Album button

Plays the album the **currently playing track** came from, starting at track 1. It works for a track reached any way at all: a station, a playlist, Feeling Lucky, Recently Added. Before it existed, hearing the rest of an album meant going to Browse and hunting for it by name.

It costs no extra Plex requests. The per-track lookup that already runs once per track for the codec carries the parent album in the same response.

If the current track has no Plex id (line-in, a non-Plex stream, a queue pushed by another app), the status line says `No album for this track` rather than erroring.

### Radio stations: Library Radio and Deep Cuts

Two endless-feeling stations, built as plain Plex track queries rather than Sonic Analysis:

- **📻 Library Radio**: random tracks from anywhere in the library.
- **🌊 Deep Cuts**: random tracks that have never been played (`viewCount=0`).

A station pushes 50 tracks, then **auto-refills**: when 10 or fewer tracks remain, the app appends another 50 to the same queue without interrupting playback. The active station is persisted to disk, so refilling survives an app restart or a redeploy.

Any finite queue (an album, a playlist, a shuffle, Feeling Lucky, the Album button) clears the station flag, so refill stops and does not append over the album's tail.

### Recently added shuffle

On the Recent tab, the Shuffle button pulls a wide pool of the most recently added tracks, shuffles it, and plays 60 of them. Recently added tracks cluster into recently added albums, so this is effectively "shuffle my new music."

### Playlists

Played in their stored order, capped at **200 tracks** per push. Smart playlists can be enormous, and the WiiM queue is finite; the status line says when a playlist was capped rather than silently truncating.

### Collections

The list of collections is re-read every time Browse opens (one small request), so a collection edited on the server is current. The albums *inside* one are fetched on drill-in and cached for the session: the biggest here run past a thousand albums across two pages, and re-entering shouldn't re-page them. Only `subtype=album` collections are listed — a music collection can hold artists instead, and those children are not albums the grid could play.

### Adaptive theming

An accent colour is extracted from each cover using Android's Palette API and normalised so it always reads well on the near-black background. It tints the Now Playing chrome, the screensaver palette and the art frame glow. On any failure the UI falls back to its default blue.

### Persistence

Kept across restarts (AsyncStorage):

- the selected WiiM device, so the app boots straight into Now Playing;
- the active station kind, so auto-refill resumes.

Nothing else persists. Clear both from Settings.

### Exit on background

When the app leaves the foreground (Home pressed, another app takes over) it **fully exits**, so it holds zero CPU, GPU and memory on the resource-tight stick. Playback is unaffected, since the WiiM is playing its own queue straight from Plex. Relaunching is a cold start back into Now Playing.

### Cover art resolution

Cover art comes from the WiiM's `getMetaInfo` (usually the Plex transcode URL). If that yields nothing, the app falls back to the MusicBrainz Cover Art Archive by artist/title.

---

## Configuration

### `src/config/hosts.data.json` (gitignored)

Every LAN address the project knows about. The app reads it through `src/config/hosts.ts`, and `deploy.sh` parses the same file, so the two can never disagree about which devices they mean. A fresh clone has no such file; copy the example:

```bash
cp src/config/hosts.data.example.json src/config/hosts.data.json
```

It holds:

| Key | Purpose |
| --- | --- |
| `plex.host` / `plex.port` | The Plex server (used over `http://` on purpose, see below) |
| `wiimDevices[]` | WiiM units with DHCP reservations, shown instantly on Discovery |
| `fireSticks.primary` | The stick a bare `./deploy.sh` installs to |
| `fireSticks.all` | Every stick `./deploy.sh all` installs to |
| `scanSubnets[]` | `/24` prefixes a network scan sweeps, in order |

Plex is addressed over plain HTTP deliberately (`usesCleartextTraffic` is enabled in the manifest): the Plex HTTPS listener presents a `*.plex.direct` certificate that fails hostname verification against a bare IP.

### `src/config/plex.ts` (gitignored)

Copy from `src/config/plex.example.ts`. Holds the music library's numeric section id and an **optional** token.

The token is opt-in and normally left commented out. A Plex server that allows unauthenticated LAN access serves metadata, artwork *and* media parts with no token at all, so carrying one is pure liability: Plex keeps honouring a **stale** token for metadata, so browsing and artwork look perfectly healthy while media parts answer 503 rather than 401. The WiiM fetches those stream URLs itself, treats each 503 as a dead track and advances, so a whole album rips past in seconds.

List section ids at `<PLEX_BASE_URL>/library/sections`.

### `src/config/display.ts` (tracked, edit in place)

Each setting is `0` (off) or `1` (on).

| Setting | Default | Effect |
| --- | --- | --- |
| `RANDOM_ORDER` | `1` | Browse's Albums grid and Artists roster are a random draw per session. `0` gives alphabetical order (albums by title, artists by name). Governs browsing only; stations, Feeling Lucky and the art-frame slideshow are random by definition. |
| `SHOW_PRESETS` | `0` | Show the WiiM Presets tab in Browse. When off, the tab is absent and the WiiM is never queried for it. |
| `SHOW_INPUTS` | `0` | Same, for the WiiM Inputs tab. |

The six library tabs (Artists, Albums, Recent, Playlists, Collections, Search) are not configurable; hiding one would strand part of the library.

> Do not add a `display.json` next to `display.ts`. Metro resolves `.json` **before** `.ts`, so a same-named JSON file silently shadows the module in a release build while Jest (which resolves `.ts` first) stays green. `deploy.sh` has a guard that fails the build on this.

---

## Build, test and deploy

```bash
./deploy.sh                 # build + install to the primary stick (use while iterating)
./deploy.sh all             # every stick in hosts.data.json
./deploy.sh 192.168.1.30    # a specific stick (repeatable)
./deploy.sh --no-check all  # skip typecheck and tests
./deploy.sh --help
```

The script first settles the toolchain that actually works together (Node 18-20, Java 17, the Android SDK). An inherited `JAVA_HOME` or `node` is used when its version qualifies and replaced when it does not — a developer machine usually has something newer installed, and both constraints are ceilings — then Homebrew, the stock macOS/Linux SDK paths, and macOS's `java_home` are searched. A preflight step reports everything missing at once, with the fix for each, before the first slow step. Then:

1. **Module shadowing guard**: fails if any `.json`/`.js` in `src/` shadows a same-named `.ts`. Runs even under `--no-check`, because it is a build correctness problem rather than a test.
2. **Checks** (unless `--no-check`): `npx tsc --noEmit`, then `npx jest --silent`.
3. **Plex streaming check**: fetches a real media part with a range request, which is the only check that distinguishes "browsing works" from "streaming works". 200/206 passes; 401/403 and 503 fail the build with an explanation.
4. **Build**: `./gradlew assembleRelease` (Hermes bundles from current source, so no separate bundle step).
5. **Deploy**, per stick: `adb connect`, verify the device state is `device` and not `unauthorized`, `install -r`, **`am force-stop`** (required, or `am start` just resumes the old process and the deploy looks like it silently did nothing), `am start`, then poll for a new pid and confirm it changed.

### Release signing

`assembleRelease` signs with a real release key **when one is configured**, and
falls back to the committed stock `debug.keystore` when it is not — so a fresh
clone still builds without you setting anything up.

Official releases on the [Releases page](../../releases) are signed with the
project's own key (`CN=ddls`, RSA 4096). That keystore is not in this repo and
never will be.

To sign your own builds, generate a keystore and point Gradle at it from
`~/.gradle/gradle.properties` (outside the repo, so it cannot be committed):

```bash
keytool -genkeypair -v -keystore ~/.wymtv/my-release.keystore -alias myalias \
  -keyalg RSA -keysize 4096 -validity 10000
```

```properties
WYMTV_RELEASE_STORE_FILE=/Users/you/.wymtv/my-release.keystore
WYMTV_RELEASE_KEY_ALIAS=myalias
WYMTV_RELEASE_STORE_PASSWORD=...
WYMTV_RELEASE_KEY_PASSWORD=...
```

Back that keystore up. Android identifies an app by its signature, so losing the
key means no future build can ever upgrade an install — only a fresh install
after uninstalling, which loses the app's stored state.

Without those properties the build uses the debug key, whose password (`android`)
is public and committed. That is fine for sideloading to your own devices on your
own LAN, and not fine for anything you hand to someone else: anyone can build an
APK that Android will install *over* one signed with it.

Standalone commands:

```bash
npx tsc --noEmit    # typecheck
npx jest            # unit tests
npm start           # Metro, for dev builds
```

Tests live in `__tests__/` and cover the pure, on-device-only-observable logic: the double XML escaping of the queue context, queue naming, hex decoding, Plex URL building with and without a token, Browse's D-pad cursor maths, the browse ordering, the compilation track-artist rule and the track-to-album mapping. `NowPlayingScreen` and the other screens are not unit tested (importing them renders React Native).

---

## Troubleshooting

**Albums rip past in seconds, a few seconds per track.** The Plex media parts are answering 503. Almost always a stale token in `src/config/plex.ts`: metadata and artwork still work, so everything looks fine until playback. Comment the token out (if the server allows unauthenticated LAN access) or refresh it. `deploy.sh` catches this before building.

**A deploy seems to have changed nothing.** The old process survived. `deploy.sh` force-stops for exactly this reason and warns if the pid did not change; if you installed by hand, `adb shell am force-stop com.wymtv` and relaunch.

**`adb connect` fails or the device shows as `unauthorized`.** Wake the stick, accept the "Allow USB debugging?" prompt on the TV, and if needed `adb kill-server && adb start-server`.

**A config value reads as `undefined` on device but tests pass.** Module shadowing: a `.json` or `.js` sitting next to the `.ts` of the same name. Rename the data file to a distinct stem, as `hosts.data.json` does.

**`⟳ reconnecting…` on Now Playing.** The WiiM has missed two consecutive polls. The app backs off exponentially from 1.5s up to 10s while it is unreachable and snaps back to normal the moment it answers again.

**The Album button says `No album for this track`.** The playing track has no Plex id: a line-in or non-Plex source, or Plex was unreachable when the track changed.

**The Queue screen names something other than "WyM TV".** The queue on the device was pushed by another app (WiiM Home, for example). Jump-to-track still works; auto-refill does not, since that only applies to queues this app created.

---

## Architecture notes

```
src/
  App.tsx              navigation stack; boots into NowPlaying when a device is remembered
  api/
    wiim.ts            LinkPlay HTTP API + PlayQueue SOAP; DIDL/QueueContext building
    plex.ts            Plex music client: catalog, artists, playlists, collections, stations, queue building
    discovery.ts       subnet scanning and single-IP probing
    coverart.ts        MusicBrainz Cover Art Archive fallback
    hex.ts             decodes the WiiM's hex-encoded metadata strings
  screens/             Discovery, NowPlaying, Browse, Album, Queue, Settings
    browseNav.ts       pure D-pad cursor maths for Browse (unit tested)
  components/
    Screensaver.tsx    Skia/SkSL visualizers, clock, album art, progress ring
    ArtFrame.tsx       digital art frame and library slideshow
  hooks/               album art resolution, accent extraction, inactivity timer
  store/               zustand stores for the device and the player, with AsyncStorage
  config/              hosts, plex, display
scripts/
  setup-config.js      creates the gitignored config from the examples on npm install
android/app/src/main/java/com/wymtv/
  MainActivity.kt      remote key interception, emits WiiMNavKey / WiiMRemoteKey
  WakeControlModule.kt keepAwake, restartApp, exitApp
```

Two conventions are load-bearing throughout the screens:

- **D-pad listeners are registered once** and read live values through refs, never from render scope. A handler that closes over render-scope state reads first-render values forever, which is what once made Browse's play silently do nothing.
- **The queue name on the device is `WiiMTV`**, not `WyM TV`. It is the device-side handle that station refill and jump-to-track address the queue by; renaming it would orphan whatever queue is playing when the new build lands.

---

## License

Code is MIT. See [LICENSE](LICENSE).

`src/assets/landing.jpg` — the photograph on the Browse landing page — is not
code and is licensed separately, under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): reuse and adaptation
are fine, including commercially, as long as you credit the author. See
[src/assets/LICENSE](src/assets/LICENSE).
