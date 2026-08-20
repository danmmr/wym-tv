package com.wymtv

import android.content.Intent
import android.view.WindowManager
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

class WakeControlModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "WakeControl"

  @ReactMethod
  fun keepAwake(enable: Boolean) {
    val activity = currentActivity ?: return
    UiThreadUtil.runOnUiThread {
      if (enable) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    }
  }

  // Full process restart: stuck native state (UPnP sockets, GPU context) survives a
  // JS reload, so schedule a fresh activity task and kill this process outright —
  // equivalent to a Fire TV force-stop followed by relaunch.
  @ReactMethod
  fun restartApp() {
    val context = reactApplicationContext
    val launchIntent =
        context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    val restartIntent = Intent.makeRestartActivityTask(launchIntent.component)
    restartIntent.setPackage(context.packageName)
    context.startActivity(restartIntent)
    Runtime.getRuntime().exit(0)
  }

  // Clean full exit (no relaunch): called when the app leaves the foreground so it
  // holds zero CPU/GPU/memory while the user is in another app. Playback is safe —
  // the WiiM streams its native PlayQueue directly from Plex, independent of this
  // app. finishAndRemoveTask() drops it from Recents; exit(0) frees the process.
  @ReactMethod
  fun exitApp() {
    val activity = currentActivity
    UiThreadUtil.runOnUiThread {
      activity?.finishAndRemoveTask()
      Runtime.getRuntime().exit(0)
    }
  }
}
