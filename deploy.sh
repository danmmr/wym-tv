#!/bin/bash
# Build and deploy WiiM TV to a Fire Stick over ADB.
# Usage: ./deploy.sh <FIRE_STICK_IP>

set -e

FIRE_IP="$1"
if [ -z "$FIRE_IP" ]; then
  echo "Usage: ./deploy.sh <FIRE_STICK_IP>"
  echo "Find the IP on the Fire Stick: Settings > My Fire TV > About > Network"
  exit 1
fi

# --- Toolchain (the versions that actually work together) ---
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"   # Node 20 (Node 25 breaks RN CLI)
export JAVA_HOME="/opt/homebrew/opt/openjdk@17"      # Java 17 (Gradle 8.x needs it, not Java 26)
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$ANDROID_SDK_ROOT/platform-tools:$PATH"
ulimit -n 65536                                      # Metro file watcher needs headroom

APK="android/app/build/outputs/apk/release/app-release.apk"

echo "==> Building release APK..."
cd "$(dirname "$0")/android"
./gradlew assembleRelease
cd ..

echo "==> Connecting to Fire Stick at $FIRE_IP ..."
adb connect "${FIRE_IP}:5555"

echo "==> Installing APK..."
adb -s "${FIRE_IP}:5555" install -r "$APK"

echo "==> Launching WiiM TV..."
adb -s "${FIRE_IP}:5555" shell am start -n com.wiimtvapp/.MainActivity

echo "Done. WiiM TV should now be open on your Fire Stick."
