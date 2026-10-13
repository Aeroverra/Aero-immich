import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/person.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/domain/services/people.service.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/utils/people.utils.dart';
import 'package:logging/logging.dart';

final peopleServiceProvider = Provider<PeopleService>(
  (ref) => PeopleService(ref.watch(driftProvider).peopleRepository, ref.watch(personApiRepositoryProvider)),
);

final peopleAssetProvider = FutureProvider.family<List<Person>, String>((ref, assetId) async {
  final service = ref.watch(peopleServiceProvider);
  return service.getAssetPeople(assetId);
});

/// Positions (in milliseconds) of the sampled video frames each person was detected in, keyed by person id.
///
/// Only meant for remote video assets. Any failure (offline, a server without video frame faces, ...)
/// yields an empty map so the details sheet never breaks.
final videoFaceTimestampsProvider = FutureProvider.autoDispose.family<Map<String, List<int>>, String>((
  ref,
  assetId,
) async {
  try {
    final faces = await ref.watch(apiServiceProvider).facesApi.getFaces(assetId);
    return groupFaceTimestampsByPerson(faces ?? const []);
  } catch (error, stack) {
    Logger('videoFaceTimestampsProvider').warning('Failed to load video face timestamps for $assetId', error, stack);
    return const {};
  }
});

final getAllPeopleProvider = StreamProvider<List<Person>>((ref) async* {
  final service = ref.watch(peopleServiceProvider);
  final prefs = await ref.watch(userMetadataPreferencesProvider.future);
  yield* service.watch(minFaces: prefs?.minimumFaces ?? 3, privateFilter: ref.watch(privateModeFilterProvider));
});
