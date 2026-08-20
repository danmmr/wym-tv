package com.wymtv

import android.view.KeyEvent
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.bridge.ReactContext
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.modules.core.DeviceEventManagerModule

class MainActivity : ReactActivity() {

  companion object {
    // When true, the app owns D-pad input (JS renders its own focus cursor).
    // Toggled from JS via the RemoteControl native module.
    //
    // Starts TRUE. It used to start false and was only turned on once a screen
    // reached its focus effect, so every press between process start and the
    // first render fell through to native focus — which draws no highlight on
    // Fire OS — and looked like a dead remote. Nothing ever sets it back to
    // false, so "off" only described the moments before JS was ready to listen.
    @Volatile var captureDpad = true
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "WymTV"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  // Forward the Fire TV remote's transport keys to JS so the app can control
  // playback. Media keys don't conflict with D-pad focus navigation, so we
  // only intercept those and let everything else behave normally.
  private fun emitToJs(event: String, value: String) {
    reactInstanceManager.currentReactContext
        ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        ?.emit(event, value)
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
    // Media keys always forward (don't conflict with focus navigation).
    val media =
        when (keyCode) {
          KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
          KeyEvent.KEYCODE_MEDIA_PLAY,
          KeyEvent.KEYCODE_MEDIA_PAUSE -> "playPause"
          KeyEvent.KEYCODE_MEDIA_NEXT,
          KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> "next"
          KeyEvent.KEYCODE_MEDIA_PREVIOUS,
          KeyEvent.KEYCODE_MEDIA_REWIND -> "prev"
          else -> null
        }
    if (media != null) {
      emitToJs("WiiMRemoteKey", media)
      return true
    }

    // D-pad: only intercept when the Now Playing screen asked to own it.
    if (captureDpad) {
      val nav =
          when (keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT -> "left"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "right"
            KeyEvent.KEYCODE_DPAD_UP -> "up"
            KeyEvent.KEYCODE_DPAD_DOWN -> "down"
            KeyEvent.KEYCODE_DPAD_CENTER,
            KeyEvent.KEYCODE_ENTER,
            KeyEvent.KEYCODE_BUTTON_A -> "select"
            KeyEvent.KEYCODE_MENU -> "menu"
            else -> null
          }
      if (nav != null) {
        emitToJs("WiiMNavKey", nav)
        return true
      }
    }
    return super.onKeyDown(keyCode, event)
  }
}
