package com.wymtv

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.flipper.ReactNativeFlipper
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.soloader.SoLoader
import java.security.KeyStore
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient

// WiiM/LinkPlay devices serve their HTTP API over HTTPS with a self-signed cert
// on a bare IP, so both chain and hostname verification fail for them. That
// exemption is for those LAN devices ONLY. It used to be granted to every
// request the app made, which also covered the one thing that leaves the LAN:
// the MusicBrainz / Cover Art Archive lookups.
//
// The split is made in the hostname verifier because it is the first place
// that knows who the peer is. A plain X509TrustManager is handed a chain and
// no host (the variant that gets one, X509ExtendedTrustManager, needs API 24,
// and this app's floor is 21), so it has to accept everything and leave the
// decision to the verifier, which OkHttp runs straight after the handshake and
// before a byte of the request is sent:
//   - a private IPv4 literal is a LAN device: accepted as before;
//   - anything else gets the checks the platform would have done on its own,
//     the system trust store against the chain and then the hostname.
class LanOnlyTrustOkHttpClientFactory : OkHttpClientFactory {
  override fun createNewNetworkModuleClient(): OkHttpClient {
    val acceptAll = object : X509TrustManager {
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
      override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
    }
    val sslContext = SSLContext.getInstance("TLS")
    sslContext.init(null, arrayOf<TrustManager>(acceptAll), java.security.SecureRandom())

    val systemTrust = systemTrustManager()
    val systemHostnames = HttpsURLConnection.getDefaultHostnameVerifier()

    return OkHttpClientProvider.createClientBuilder()
        .sslSocketFactory(sslContext.socketFactory, acceptAll)
        .hostnameVerifier { hostname, session ->
          if (isPrivateIpv4(hostname)) {
            true
          } else {
            try {
              val chain =
                  session.peerCertificates.map { it as X509Certificate }.toTypedArray()
              // The auth type only has to be non-empty; the platform trust
              // manager validates the chain itself, not the label.
              systemTrust.checkServerTrusted(chain, "RSA")
              systemHostnames.verify(hostname, session)
            } catch (e: Exception) {
              false
            }
          }
        }
        .build()
  }

  private fun systemTrustManager(): X509TrustManager {
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    factory.init(null as KeyStore?)
    return factory.trustManagers.first { it is X509TrustManager } as X509TrustManager
  }

  companion object {
    // Literal addresses only, parsed as text: resolving a NAME to see where it
    // points would let DNS decide who is exempt. 10/8, 172.16/12, 192.168/16
    // and link-local 169.254/16.
    fun isPrivateIpv4(host: String): Boolean {
      val parts = host.split(".")
      if (parts.size != 4) return false
      val o = parts.map { p ->
        if (p.isEmpty() || p.length > 3 || !p.all { it in '0'..'9' }) return false
        val n = p.toInt()
        if (n > 255) return false
        n
      }
      return o[0] == 10 ||
          (o[0] == 172 && o[1] in 16..31) ||
          (o[0] == 192 && o[1] == 168) ||
          (o[0] == 169 && o[1] == 254)
    }
  }
}

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              add(RemoteControlPackage())
              add(WakeControlPackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(this.applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // Trust WiiM self-signed certs, for LAN addresses only.
    OkHttpClientProvider.setOkHttpClientFactory(LanOnlyTrustOkHttpClientFactory())
    SoLoader.init(this, false)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      load()
    }
    ReactNativeFlipper.initializeFlipper(this, reactNativeHost.reactInstanceManager)
  }
}
