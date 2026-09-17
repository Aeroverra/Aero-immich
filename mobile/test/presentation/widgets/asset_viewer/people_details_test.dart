import 'dart:io';

import 'package:drift/drift.dart' show DatabaseConnection;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/events.model.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/domain/utils/event_stream.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_details/people_details.widget.dart';
import 'package:immich_mobile/providers/asset_viewer/video_player_provider.dart';
import 'package:immich_mobile/providers/infrastructure/people.provider.dart';
import 'package:immich_mobile/services/gcast.service.dart';
import 'package:mocktail/mocktail.dart';
import 'package:native_video_player/native_video_player.dart';

import '../../../mock_http_override.dart';
import '../../../service.mocks.dart';
import '../../../test_utils.dart';
import '../../../unit/factories/remote_asset_factory.dart';
import '../../../widget_tester_extensions.dart';

class MockNativeVideoPlayerController extends Mock implements NativeVideoPlayerController {}

class _TestVideoPlayerNotifier extends VideoPlayerNotifier {
  void markPlaying() => state = state.copyWith(status: VideoPlaybackStatus.playing);
}

void main() {
  const alice = Person(id: 'person-a', name: 'Alice');
  const bob = Person(id: 'person-b', name: 'Bob');

  late MockNativeVideoPlayerController controller;
  late _TestVideoPlayerNotifier player;
  late MockGCastService castService;

  late Drift db;

  setUpAll(() async {
    TestUtils.init();
    HttpOverrides.global = MockHttpOverrides();
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: StoreRepository(db));
    await Store.put(StoreKey.serverEndpoint, 'http://localhost/api');
  });

  tearDownAll(() async {
    HttpOverrides.global = null;
    await db.close();
  });

  setUp(() {
    controller = MockNativeVideoPlayerController();
    when(controller.play).thenAnswer((_) async {});
    when(controller.pause).thenAnswer((_) async {});
    when(() => controller.seekTo(any())).thenAnswer((_) async {});
    player = _TestVideoPlayerNotifier()..attachController(controller);
    castService = MockGCastService();
  });

  Future<void> pumpDetails(WidgetTester tester, RemoteAsset asset, Map<String, List<int>> timestamps) {
    return tester.pumpConsumerWidget(
      SingleChildScrollView(
        child: Column(
          children: [
            // Stands in for the video viewer, which keeps the player of the displayed asset alive.
            Consumer(
              builder: (context, ref, _) {
                ref.watch(videoPlayerProvider(asset.id));
                return const SizedBox.shrink();
              },
            ),
            PeopleDetails(asset: asset),
          ],
        ),
      ),
      overrides: [
        peopleAssetProvider.overrideWith((ref, id) async => const [alice, bob]),
        videoFaceTimestampsProvider.overrideWith((ref, id) async => timestamps),
        videoPlayerProvider.overrideWith((ref, id) => player),
        gCastServiceProvider.overrideWithValue(castService),
      ],
    );
  }

  testWidgets('shows at most three time chips per person and a remaining count', (tester) async {
    final asset = RemoteAssetFactory.create(type: .video);
    await pumpDetails(tester, asset, {
      alice.id: [1000, 12000, 65000, 3723000, 4000000],
    });

    expect(find.text('00:01'), findsOneWidget);
    expect(find.text('00:12'), findsOneWidget);
    expect(find.text('01:05'), findsOneWidget);
    expect(find.text('01:02:03'), findsNothing);
    expect(find.text('+2'), findsOneWidget);
    expect(find.bySemanticsLabel('Jump to 00:12'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('does not show time chips for photos', (tester) async {
    final asset = RemoteAssetFactory.create();
    await pumpDetails(tester, asset, {
      alice.id: [1000],
    });

    expect(find.text('Alice'), findsOneWidget);
    expect(find.text('00:01'), findsNothing);
  });

  testWidgets('tapping a chip seeks, closes the sheet and leaves the video paused', (tester) async {
    final asset = RemoteAssetFactory.create(type: .video);
    final hideEvents = <ViewerHideDetailsEvent>[];
    final subscription = EventStream.shared.listen<ViewerHideDetailsEvent>(hideEvents.add);
    addTearDown(subscription.cancel);

    await pumpDetails(tester, asset, {
      bob.id: [12000],
    });

    // The video was playing when the details sheet opened, which holds playback.
    player.markPlaying();
    player.hold();
    await tester.pump();
    clearInteractions(controller);

    await tester.tap(find.text('00:12'));
    await tester.pump();

    expect(hideEvents, hasLength(1));
    expect(player.state.position, const Duration(seconds: 12));
    verifyInOrder([controller.pause, () => controller.seekTo(12000)]);

    // Closing the sheet releases the hold, which must not resume playback.
    player.release();
    await tester.pump(const Duration(milliseconds: 200));

    // No play and no second seek once the pending seek timer would have fired.
    verifyNoMoreInteractions(controller);
  });
}
