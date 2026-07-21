#!/bin/bash
# Build and deploy WiiM TV to one or more Fire Sticks over ADB.
#
# Usage:
#   ./deploy.sh                 # primary stick only (default while iterating)
#   ./deploy.sh all             # every stick in STICKS
#   ./deploy.sh 192.168.2.187   # a specific stick (repeatable)
#   ./deploy.sh --no-check all  # skip typecheck + tests
#
# Find a stick's IP on the device: Settings > My Fire TV > About > Network.

set -euo pipefail

# Known devices. PRIMARY is what a bare ./deploy.sh targets — deploy there
# first while iterating, then `./deploy.sh all` once a change is settled.
PRIMARY="192.168.2.186"
STICKS=("192.168.2.186" "192.168.2.187")

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

# --- Checks ----------------------------------------------------------------
# Cheap next to a gradle build, and they catch the encoding regressions that
# would otherwise only show up as mangled metadata on the TV.
if [ "$RUN_CHECKS" -eq 1 ]; then
  echo "==> Typechecking..."
  npx tsc --noEmit
  echo "==> Running tests..."
  npx jest --silent
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
