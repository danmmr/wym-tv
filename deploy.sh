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

# --- Plex token ------------------------------------------------------------
# The app is an APK on a Fire Stick, so unlike the Python tooling in a local helper script
# (which reads ~/.config/plex/token at runtime via plex_creds.py) it has to bake
# the token in at build time. Sync it from that same file here so a rotation is
# still a one-file edit and can never leave the sticks holding a dead token.
#
# Why this matters: Plex keeps honouring a STALE token for metadata, so browsing,
# artwork and track listings all look perfectly healthy — it refuses only media
# parts, and answers 503 rather than 401. The WiiM fetches those stream URLs
# itself, treats each 503 as a dead track and advances, so a whole album rips
# past in seconds. That is what broke on 2026-08-02.
TOKEN_FILE="$HOME/.config/plex/token"
CFG="src/config/plex.ts"

if [ -f "$TOKEN_FILE" ]; then
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

  # Verify the token can actually STREAM, not just browse. A range request
  # against a real media part is the only check that tells those apart:
  # a stale token returns 503 here while /library/sections still returns 200.
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
  P_SEC=$(sed -n "s/^[[:space:]]*musicSection:[[:space:]]*\([0-9]*\).*/\1/p" "$CFG" | head -1)

  PART=$(curl -s --max-time 20 -H 'Accept: application/json' \
    "$P_BASE/library/sections/$P_SEC/all?type=10&sort=random&X-Plex-Container-Size=1&X-Plex-Token=$P_TOK" \
    | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin)["MediaContainer"]["Metadata"][0]["Media"][0]["Part"][0]["key"])
except Exception:
    pass' 2>/dev/null || true)

  if [ -z "$PART" ]; then
    # Could not even list a track: server down, or unreachable from this Mac.
    # Not necessarily a bad token, so warn rather than block the build.
    echo "    WARNING: could not reach Plex at $P_BASE to verify the token" >&2
  else
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -r 0-1023 \
      "$P_BASE$PART?X-Plex-Token=$P_TOK" || echo 000)
    case "$CODE" in
      200|206)
        echo "    streaming OK (HTTP $CODE)" ;;
      401|403)
        echo "    Plex rejected the token (HTTP $CODE). Update $TOKEN_FILE." >&2
        exit 1 ;;
      503)
        echo "    Plex returns 503 on media parts — the token is stale (browsing still works)." >&2
        echo "    Put the current token in $TOKEN_FILE and re-run; otherwise the sticks will" >&2
        echo "    skip through every album in seconds." >&2
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
