#!/bin/bash
# Build and deploy WiiM TV to one or more Fire Sticks over ADB.
#
# Usage:
#   ./deploy.sh                 # primary stick only (default while iterating)
#   ./deploy.sh all             # every stick in STICKS
#   ./deploy.sh <stick-ip>      # a specific stick (repeatable)
#   ./deploy.sh --no-check all  # skip typecheck + tests
#
# The sticks live in src/config/hosts.data.json, alongside every other LAN address.
# Find a stick's IP on the device: Settings > My Fire TV > About > Network.

set -euo pipefail

APP_ID="com.wiimtvapp"
ACTIVITY="$APP_ID/.MainActivity"
APK="android/app/build/outputs/apk/release/app-release.apk"

# --- Toolchain (the versions that actually work together) ---
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"   # Node 20 (Node 25 breaks RN CLI)
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"      # Java 17 (Gradle 8.x needs it, not Java 26)
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$ANDROID_SDK_ROOT/platform-tools:$PATH"
ulimit -n 65536                                      # Metro file watcher needs headroom

cd "$(dirname "$0")"

# --- Hosts -----------------------------------------------------------------
# Every LAN address lives in src/config/hosts.data.json — the same file the app
# imports (via src/config/hosts.ts). Read the stick list from there rather than
# repeating it here, so moving a device is a one-file edit and the script can
# never target a stick the app no longer knows about.
#
# PRIMARY is what a bare ./deploy.sh targets — deploy there first while
# iterating, then `./deploy.sh all` once a change is settled.
HOSTS="src/config/hosts.data.json"
if [ ! -f "$HOSTS" ]; then
  echo "Missing $HOSTS — it holds the Fire Stick and Plex addresses." >&2
  echo "It is gitignored, so a fresh clone does not have one. Copy the example" >&2
  echo "and put your own addresses in:" >&2
  echo "    cp ${HOSTS%.json}.example.json $HOSTS" >&2
  exit 1
fi

read_hosts() {  # read_hosts <python-expression over `h`>
  python3 -c "import json,sys
h = json.load(open('$HOSTS'))
print($1)" 2>/dev/null
}

PRIMARY=$(read_hosts "h['fireSticks']['primary']")
# shellcheck disable=SC2207
STICKS=($(read_hosts "' '.join(h['fireSticks']['all'])"))
PLEX_BASE=$(read_hosts "'http://%s:%d' % (h['plex']['host'], h['plex']['port'])")

if [ -z "$PRIMARY" ] || [ ${#STICKS[@]} -eq 0 ] || [ -z "$PLEX_BASE" ]; then
  echo "Could not read fireSticks/plex out of $HOSTS — is it valid JSON?" >&2
  exit 1
fi

# --- Arguments -------------------------------------------------------------
RUN_CHECKS=1
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --no-check) RUN_CHECKS=0 ;;
    all)        TARGETS=("${STICKS[@]}") ;;
    -h|--help)  sed -n '2,10p' "$0"; exit 0 ;;
    *)          TARGETS+=("$arg") ;;
  esac
done
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=("$PRIMARY")
fi

# --- Module shadowing guard ------------------------------------------------
# Metro resolves sourceExts in the order js, jsx, json, ts, tsx — every one of
# those BEFORE TypeScript. So a foo.json (or foo.js) sitting next to foo.ts
# makes `import {x} from './foo'` load the wrong file, and every export from
# the .ts becomes undefined.
#
# What makes it vicious is that it is invisible here: JEST resolves ts FIRST,
# so the whole suite stays green while the sticks run the shadowing file. On
# 2026-08-13 src/config/hosts.json shadowed hosts.ts for three deploys — the
# Discovery screen crashed only after a clean install, and the Plex half never
# crashed at all, it just quietly dropped the codec from the Now Playing line.
#
# This runs even under --no-check: it costs nothing and it is a build
# correctness problem, not a test.
SHADOWED=""
for candidate in $(find src -type f \( -name '*.json' -o -name '*.js' -o -name '*.jsx' \) 2>/dev/null); do
  base="${candidate%.*}"
  if [ -f "$base.ts" ] || [ -f "$base.tsx" ]; then
    SHADOWED="$SHADOWED  $candidate shadows $base.ts"$'\n'
  fi
done
if [ -n "$SHADOWED" ]; then
  echo "==> Module shadowing detected:" >&2
  printf '%s' "$SHADOWED" >&2
  echo "    Metro loads these BEFORE the .ts, so its exports would be undefined" >&2
  echo "    on device while the tests here stay green. Rename the data file with" >&2
  echo "    a distinct stem (hosts.data.json is the existing example)." >&2
  exit 1
fi

# --- Plex token (optional) -------------------------------------------------
# The token is OPT-IN. This server allows unauthenticated access on the LAN, so
# the app ships without one: verified with negative controls on 2026-08-13, a
# media part returns 206 with a real token and 206 with none, but 503 with a
# WRONG one. Carrying a token is therefore pure downside — Plex keeps honouring
# a STALE one for metadata, so browsing and artwork look perfectly healthy while
# media parts answer 503 rather than 401. The WiiM fetches those stream URLs
# itself, treats each 503 as a dead track and advances, so a whole album rips
# past in seconds. That is what broke on 2026-08-02.
#
# To opt in, uncomment the token line in src/config/plex.ts. An APK on a Fire
# Stick cannot read ~/.config/plex/token at runtime the way the Python tooling
# in a local helper script does, so it gets baked in here at build time — and only then.
TOKEN_FILE="$HOME/.config/plex/token"
CFG="src/config/plex.ts"

# An active token line is uncommented; a commented one means "no token wanted"
# and must NOT be resurrected from the token file.
TOKEN_ACTIVE=0
grep -qE "^[[:space:]]*token:[[:space:]]*'" "$CFG" && TOKEN_ACTIVE=1

if [ "$TOKEN_ACTIVE" -eq 0 ]; then
  echo "==> Plex token not in use (commented out in $CFG) — requests go unauthenticated"
elif [ -f "$TOKEN_FILE" ]; then
  FILE_TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE")
  CFG_TOKEN=$(sed -n "s/^[[:space:]]*token:[[:space:]]*'\([^']*\)'.*/\1/p" "$CFG" | head -1)
  if [ -z "$FILE_TOKEN" ]; then
    echo "==> WARNING: $TOKEN_FILE is empty; keeping the token already in $CFG" >&2
  elif [ "$FILE_TOKEN" != "$CFG_TOKEN" ]; then
    # Rewrite just the token line, preserving indentation and the rest of the file.
    awk -v tok="$FILE_TOKEN" '
      /^[[:space:]]*token:[[:space:]]*'\''/ && !done {
        match($0, /^[[:space:]]*/)
        printf "%stoken: '\''%s'\'',\n", substr($0, 1, RLENGTH), tok
        done = 1
        next
      }
      { print }
    ' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
    echo "==> Plex token synced from $TOKEN_FILE"
  else
    echo "==> Plex token already current"
  fi
else
  echo "==> WARNING: $TOKEN_FILE not found; using the token already in $CFG" >&2
fi

# --- Checks ----------------------------------------------------------------
# Cheap next to a gradle build, and they catch the encoding regressions that
# would otherwise only show up as mangled metadata on the TV.
if [ "$RUN_CHECKS" -eq 1 ]; then
  echo "==> Typechecking..."
  npx tsc --noEmit
  echo "==> Running tests..."
  npx jest --silent

  # Verify the app's Plex config can actually STREAM, not just browse. A range
  # request against a real media part is the only check that tells those apart:
  # a stale token returns 503 here while /library/sections still returns 200.
  # This runs whether or not a token is configured — "no token" is a claim about
  # the server that deserves testing exactly as much as a token does.
  echo "==> Checking Plex streaming..."
  # The address comes from hosts.data.json (same value the app builds), the token
  # from plex.ts. A plex.ts left over from before the addresses moved out would
  # still carry its own literal baseUrl, and the app would then use a server
  # this check never looked at — so say so loudly rather than silently drift.
  P_BASE="$PLEX_BASE"
  if grep -qE "^[[:space:]]*baseUrl:[[:space:]]*'" "$CFG"; then
    echo "    $CFG still hard-codes baseUrl. Replace that line with" >&2
    echo "    'baseUrl: PLEX_BASE_URL,' (see src/config/plex.example.ts) so the" >&2
    echo "    address comes from $HOSTS." >&2
    exit 1
  fi
  P_TOK=$(sed -n "s/^[[:space:]]*token:[[:space:]]*'\([^']*\)'.*/\1/p" "$CFG" | head -1)
  # Require at least one DIGIT. `[0-9]*` also matches zero digits, so it happily
  # captured "" from the `musicSection: number;` line of the type annotation and
  # left this check requesting /library/sections//all — which fails in a way that
  # only warns, i.e. a check that could no longer catch anything.
  P_SEC=$(sed -n "s/^[[:space:]]*musicSection:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$CFG" | head -1)
  if [ -z "$P_SEC" ]; then
    echo "    could not read musicSection out of $CFG — the streaming check cannot run." >&2
    exit 1
  fi

  # Send NO token parameter when none is configured. An empty X-Plex-Token= is
  # not the same request as omitting it — an empty value can read as a wrong
  # token, which is the one case Plex answers 503 to.
  if [ -n "$P_TOK" ]; then
    TOK_Q="&X-Plex-Token=$P_TOK"
    TOK_Q1="?X-Plex-Token=$P_TOK"
  else
    TOK_Q=""
    TOK_Q1=""
  fi

  PART=$(curl -s --max-time 20 -H 'Accept: application/json' \
    "$P_BASE/library/sections/$P_SEC/all?type=10&sort=random&X-Plex-Container-Size=1$TOK_Q" \
    | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin)["MediaContainer"]["Metadata"][0]["Media"][0]["Part"][0]["key"])
except Exception:
    pass' 2>/dev/null || true)

  if [ -z "$PART" ]; then
    # Could not even list a track: server down, or unreachable from this Mac.
    # Not necessarily a bad token, so warn rather than block the build.
    echo "    WARNING: could not reach Plex at $P_BASE to verify streaming" >&2
  else
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -r 0-1023 \
      "$P_BASE$PART$TOK_Q1" || echo 000)
    case "$CODE" in
      200|206)
        if [ -n "$P_TOK" ]; then
          echo "    streaming OK (HTTP $CODE, with token)"
        else
          echo "    streaming OK (HTTP $CODE, no token needed)"
        fi ;;
      401|403)
        if [ -n "$P_TOK" ]; then
          echo "    Plex rejected the token (HTTP $CODE). Update $TOKEN_FILE." >&2
        else
          echo "    Plex requires authentication (HTTP $CODE) but no token is configured." >&2
          echo "    Uncomment the token line in $CFG — see src/config/plex.example.ts." >&2
        fi
        exit 1 ;;
      503)
        if [ -n "$P_TOK" ]; then
          echo "    Plex returns 503 on media parts — the token is stale (browsing still works)." >&2
          echo "    Put the current token in $TOKEN_FILE and re-run; otherwise the sticks will" >&2
          echo "    skip through every album in seconds." >&2
        else
          echo "    Plex returns 503 on media parts with no token (browsing still works)." >&2
          echo "    This server no longer allows unauthenticated local access. Uncomment the" >&2
          echo "    token line in $CFG; otherwise the sticks will skip every album in seconds." >&2
        fi
        exit 1 ;;
      *)
        echo "    WARNING: unexpected HTTP $CODE fetching a media part" >&2 ;;
    esac
  fi
fi

# --- Build -----------------------------------------------------------------
# Hermes is enabled, so gradle generates its own bytecode bundle from current
# source on each non-cached build; the standalone `react-native bundle` step is
# redundant here. assembleRelease is the whole build.
echo "==> Building release APK..."
(cd android && ./gradlew assembleRelease -q)

if [ ! -f "$APK" ]; then
  echo "Build succeeded but $APK is missing." >&2
  exit 1
fi
echo "    $(du -h "$APK" | cut -f1) $APK"

# --- Deploy ----------------------------------------------------------------
FAILED=()
for IP in "${TARGETS[@]}"; do
  DEV="${IP}:5555"
  echo
  echo "==> $DEV"

  if ! adb connect "$DEV" | grep -qE "connected to"; then
    echo "    could not connect (is the stick awake? try: adb kill-server && adb start-server)" >&2
    FAILED+=("$IP")
    continue
  fi

  # An 'unauthorized' device needs the "Allow USB debugging?" dialog accepted
  # on the TV, and reports install failures in a confusing way otherwise.
  STATE=$(adb devices | awk -v d="$DEV" '$1==d {print $2}')
  if [ "$STATE" != "device" ]; then
    echo "    device state is '${STATE:-unknown}', not 'device' — accept the debugging prompt on the TV" >&2
    FAILED+=("$IP")
    continue
  fi

  OLD_PID=$(adb -s "$DEV" shell pidof "$APP_ID" 2>/dev/null | tr -d '\r' || true)

  echo "    installing..."
  adb -s "$DEV" install -r "$APK" >/dev/null

  # REQUIRED: after `install -r`, `am start` often just resumes the already
  # running OLD process instead of loading the new bundle, so the screen looks
  # unchanged and the deploy appears to have silently not applied. force-stop
  # guarantees a cold JS load.
  adb -s "$DEV" shell am force-stop "$APP_ID"
  adb -s "$DEV" shell am start -n "$ACTIVITY" >/dev/null

  # Cold start is ~10-15s; poll rather than guess.
  NEW_PID=""
  for _ in $(seq 1 20); do
    sleep 1
    NEW_PID=$(adb -s "$DEV" shell pidof "$APP_ID" 2>/dev/null | tr -d '\r' || true)
    [ -n "$NEW_PID" ] && break
  done

  if [ -z "$NEW_PID" ]; then
    echo "    installed, but the app did not come up" >&2
    FAILED+=("$IP")
  elif [ -n "$OLD_PID" ] && [ "$NEW_PID" = "$OLD_PID" ]; then
    # Proves the force-stop actually took: a reused pid means the old process
    # survived and the new bundle is not running.
    echo "    WARNING: pid unchanged ($NEW_PID) — old process may still be running" >&2
    FAILED+=("$IP")
  else
    echo "    running (pid ${OLD_PID:-none} -> $NEW_PID)"
  fi
done

echo
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "Failed: ${FAILED[*]}" >&2
  exit 1
fi
echo "Deployed to: ${TARGETS[*]}"
