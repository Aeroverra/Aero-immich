import 'package:immich_mobile/models/server_info/server_features.model.dart';
import 'package:immich_mobile/models/server_info/server_version.model.dart';
import 'package:immich_mobile/providers/server_info.provider.dart';

class StubServerInfoNotifier extends ServerInfoNotifier {
  StubServerInfoNotifier(super.serverInfoService, {ServerVersion? version, ServerFeatures? features}) {
    state = state.copyWith(
      serverVersion: version ?? state.serverVersion,
      serverFeatures: features ?? state.serverFeatures,
    );
  }
}
