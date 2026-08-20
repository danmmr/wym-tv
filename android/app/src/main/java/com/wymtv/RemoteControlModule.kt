package com.wymtv

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

// Lets JS toggle whether the Now Playing screen wants to own D-pad input.
// When enabled, MainActivity forwards D-pad keys to JS instead of moving
// native focus (so we can render our own visible focus cursor).
class RemoteControlModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "RemoteControl"

  @ReactMethod
  fun setCaptureDpad(enabled: Boolean) {
    MainActivity.captureDpad = enabled
  }
}
