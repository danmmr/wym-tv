package com.wymtv

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.WindowManager
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

class WakeControlModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

  init {
    reactContext.addLifecycleEventListener(this)
  }

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

  // Deferred exitApp(). A transient full-screen overlay (Alexa's APL cards are a
  // separate activity) backgrounds the app for ~30s; exiting at once means the card
  // closes onto the Fire TV home screen instead of back onto WyM. The timer lives
  // here, not in JS, because React Native pauses JS timers while the host is
  // backgrounded. cancelExit() on return to the foreground disarms it.
  private val exitHandler = Handler(Looper.getMainLooper())
  private val exitRunnable = Runnable { exitApp() }

  // The delay is only for overlays. When the user left for a launcher (Home, or
  // the Recents screen) the app quits at once, so coming back is a cold start
  // rather than a resume onto whatever screen was open. Android cannot tell the two
  // apart for us: an Alexa card pauses the app with userLeaving=true exactly as Home
  // does. So look at what is in front a moment after leaving instead. That needs
  // usage access, which deploy.sh grants over adb; without it nothing is reported,
  // and the app keeps the delayed exit, i.e. the old behaviour.
  private val leaveCheckRunnable = Runnable {
    val front = foregroundPackage()
    Log.i(TAG, "left for ${front ?: "unknown"}")
    if (front != null && front in launcherPackages()) exitApp()
  }

  // Every installed Home app, not just the default: a replacement launcher such as
  // Projectivy takes the Home key while Amazon's stays the resolved default and
  // still owns the Recents screen. Negative priority is skipped: Fire's Settings app
  // registers a FallbackHome at -1000, and opening Settings is not leaving for Home.
  // Needs the HOME <queries> entry in the manifest.
  private fun launcherPackages(): Set<String> =
      reactApplicationContext.packageManager
          .queryIntentActivities(
              Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), 0)
          .filter { it.priority >= 0 }
          .map { it.activityInfo.packageName }
          .toSet()

  @ReactMethod
  fun scheduleExit(delayMs: Double) {
    cancelExit()
    exitHandler.postDelayed(leaveCheckRunnable, LEAVE_CHECK_MS)
    exitHandler.postDelayed(exitRunnable, delayMs.toLong())
  }

  @ReactMethod
  fun cancelExit() {
    exitHandler.removeCallbacks(leaveCheckRunnable)
    exitHandler.removeCallbacks(exitRunnable)
  }

  // The package that most recently came to the foreground, or null when usage
  // access is not granted (queryEvents then returns nothing).
  private fun foregroundPackage(): String? =
      try {
        val usm =
            reactApplicationContext.getSystemService(Context.USAGE_STATS_SERVICE)
                as UsageStatsManager
        val now = System.currentTimeMillis()
        val events = usm.queryEvents(now - 10_000, now)
        val event = UsageEvents.Event()
        var pkg: String? = null
        while (events.hasNextEvent()) {
          events.getNextEvent(event)
          if (event.eventType == UsageEvents.Event.ACTIVITY_RESUMED) pkg = event.packageName
        }
        pkg
      } catch (e: Exception) {
        null
      }

  companion object {
    private const val TAG = "WakeControl"
    // The launcher resumes within ~30ms of the app pausing; a second is ample.
    private const val LEAVE_CHECK_MS = 1000L
  }

  // Disarm on every return to the foreground, natively. The JS AppState listener
  // alone misses one path: Back on the root screen finishes the activity (which
  // unmounts App and its listener) but leaves the process alive, so a relaunch
  // inside the delay is already 'active' before the new listener subscribes and
  // the pending exit kills the app two minutes after the user left.
  override fun onHostResume() {
    cancelExit()
  }

  override fun onHostPause() {}

  override fun onHostDestroy() {}
}
