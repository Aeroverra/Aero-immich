import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/domain/services/user.service.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_details/tags_details.widget.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/tagging.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:mocktail/mocktail.dart';

import '../../../infrastructure/repository.mock.dart';
import '../../../test_utils.dart';
import '../../../widget_tester_extensions.dart';

class _MockUserService extends Mock implements UserService {}

class _MockTaggingService extends Mock implements TaggingService {}

const _me = 'user-1';
const _cake = TagEntry(id: 'cake', ownerId: _me, value: 'Food/Cake');

RemoteAsset _asset(String id) => RemoteAsset(
  id: id,
  checksum: 'checksum-$id',
  ownerId: _me,
  name: '$id.mp4',
  type: AssetType.video,
  createdAt: DateTime(2026),
  updatedAt: DateTime(2026),
  uploadedAt: DateTime(2026),
  durationMs: 1000,
  isFavorite: false,
  isEdited: false,
  stackId: 'stack-1',
);

void main() {
  // a Video Boost pair, stacked by hand: the user handles it as one item
  final video = _asset('video');
  final boosted = _asset('boosted');
  late _MockTaggingService tagging;

  setUpAll(TestUtils.init);

  setUp(() {
    tagging = _MockTaggingService();
    when(() => tagging.removeTag(any(), any())).thenAnswer((_) async {});
  });

  Future<void> pump(WidgetTester tester) {
    final userService = _MockUserService();
    final user = UserDto(id: _me, email: 'user@test.dev', name: 'user', profileChangedAt: DateTime(2026));
    when(() => userService.tryGetMyUser()).thenReturn(user);
    when(() => userService.watchMyUser()).thenAnswer((_) => const Stream.empty());
    final remoteAssets = MockRemoteAssetRepository();
    when(() => remoteAssets.getAutoStackIds(any())).thenAnswer((_) async => const {});
    when(
      () => remoteAssets.getStackAssets(any(), includeAutoStacks: any(named: 'includeAutoStacks')),
    ).thenAnswer((_) async => [video, boosted]);
    final drift = MockDrift();
    when(() => drift.remoteAssetRepository).thenReturn(remoteAssets);

    return tester.pumpConsumerWidget(
      TagsDetails(asset: video),
      overrides: [
        currentUserProvider.overrideWith((ref) => CurrentUserProvider(userService)),
        userMetadataPreferencesProvider.overrideWith((ref) async => const Preferences(tagsEnabled: true)),
        customViewsSupportedProvider.overrideWithValue(true),
        assetTagsProvider.overrideWith((ref, assetId) => Stream.value(const [_cake])),
        taggingServiceProvider.overrideWithValue(tagging),
        driftProvider.overrideWithValue(drift),
      ],
    );
  }

  testWidgets('removing a tag of a manual stack removes it from the whole stack', (tester) async {
    await pump(tester);
    await tester.pumpAndSettle();

    final chip = tester.widget<InputChip>(find.byKey(const Key('asset-tag-cake')));
    chip.onDeleted!();
    await tester.pumpAndSettle();

    verify(() => tagging.removeTag('cake', ['video', 'boosted'])).called(1);
  });
}
