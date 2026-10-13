package app.alextran.immich.screen

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import io.flutter.embedding.engine.plugins.FlutterPlugin

/**
 * Reports the screen turning off to Dart, so private mode and custom views can relock on a screen off while an app
 * switch (a share sheet, the target app) leaves them unlocked.
 *
 * ACTION_SCREEN_OFF is only delivered to a receiver registered at runtime, so it is registered here for as long as
 * the engine is attached, foreground or not.
 */
class ScreenStatePlugin : FlutterPlugin, ScreenStateHostApi {
  private var context: Context? = null
  private var flutterApi: ScreenStateFlutterApi? = null
  private var receiver: BroadcastReceiver? = null

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    val context = binding.applicationContext
    this.context = context
    flutterApi = ScreenStateFlutterApi(binding.binaryMessenger)
    ScreenStateHostApi.setUp(binding.binaryMessenger, this)

    val receiver = object : BroadcastReceiver() {
      override fun onReceive(receiverContext: Context?, intent: Intent?) {
        if (intent?.action == Intent.ACTION_SCREEN_OFF) {
          flutterApi?.onScreenOff { }
        }
      }
    }
    this.receiver = receiver

    val filter = IntentFilter(Intent.ACTION_SCREEN_OFF)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      context.registerReceiver(receiver, filter)
    }
  }

  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    receiver?.let { context?.unregisterReceiver(it) }
    receiver = null
    ScreenStateHostApi.setUp(binding.binaryMessenger, null)
    flutterApi = null
    context = null
  }

  override fun isScreenOffReported(): Boolean = true
}
