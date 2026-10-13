import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(
  PigeonOptions(
    dartOut: 'lib/platform/screen_state_api.g.dart',
    kotlinOut: 'android/app/src/main/kotlin/app/alextran/immich/screen/ScreenState.g.kt',
    kotlinOptions: KotlinOptions(package: 'app.alextran.immich.screen'),
    dartOptions: DartOptions(),
    dartPackageName: 'immich_mobile',
  ),
)
@HostApi()
abstract class ScreenStateHostApi {
  /// Whether this platform reports the screen turning off, so "lock when the screen turns off" can be offered
  bool isScreenOffReported();
}

@FlutterApi()
abstract class ScreenStateFlutterApi {
  /// The screen turned off or the device locked
  void onScreenOff();
}
