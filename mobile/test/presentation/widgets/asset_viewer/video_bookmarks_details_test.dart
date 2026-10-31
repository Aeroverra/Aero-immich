import 'dart:io';

import 'package:drift/drift.dart' show DatabaseConnection;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/data/server/video_bookmark.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/events.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/models/video_bookmark.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/domain/utils/event_stream.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_details/video_bookmarks_details.widget.dart';
import 'package:immich_mobile/providers/asset_viewer/video_player_provider.dart';
import 'package:immich_mobile/services/gcast.service.dart';
import 'package:immich_mobile/widgets/asset_viewer/video_controls.dart';
import 'package:mocktail/mocktail.dart';
import 'package:native_video_player/native_video_player.dart';

import '../../../mock_http_override.dart';
import '../../../service.mocks.dart';
import '../../../test_utils.dart';
import '../../../unit/factories/remote_asset_factory.dart';
import '../../../widget_tester_extensions.dart';

class MockNativeVideoPlayerController extends Mock implements NativeVideoPlayerController {}

class _MockVideoBookmarkApiRepository extends Mock implements VideoBookmarkApiRepository {}

class _TestVideoPlayerNotifier extends VideoPlayerNotifier {
  void markPaused() => state = state.copyWith(status: VideoPlaybackStatus.paused);
}

void main() {
  late MockNativeVideoPlayerController controller;
  late _TestVideoPlayerNotifier player;
  late MockGCastService castService;
  late _MockVideoBookmarkApiRepository api;
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
    api = _MockVideoBookmarkApiRepository();
  });

  Future<void> pumpDetails(WidgetTester tester, RemoteAsset asset, List<VideoBookmark> bookmarks) {
    when(() => api.getAll(any())).thenAnswer((_) async => bookmarks);
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
            VideoBookmarksDetails(asset: asset),
          ],
        ),
      ),
      overrides: [
        videoBookmarkApiRepositoryProvider.overrideWithValue(api),
        videoPlayerProvider.overrideWith((ref, id) => player),
        gCastServiceProvider.overrideWithValue(castService),
      ],
    );
  }

  testWidgets('lists the bookmarks with their time, unnamed ones as untitled', (tester) async {
    final asset = RemoteAssetFactory.create(type: .video);
    await pumpDetails(tester, asset, [
      VideoBookmark(id: 'a', assetId: asset.id, time: 12000, label: 'Kickoff'),
      VideoBookmark(id: 'b', assetId: asset.id, time: 95000, label: ''),
    ]);
    await tester.pumpAndSettle();

    expect(find.text('Bookmarks'), findsOneWidget);
    expect(find.text('Kickoff'), findsOneWidget);
    expect(find.text('00:12'), findsOneWidget);
    expect(find.text('Untitled bookmark'), findsOneWidget);
    expect(find.bySemanticsLabel('Jump to 01:35: Untitled bookmark'), findsOneWidget);
  });

  testWidgets('shows a hint when the video has no bookmarks yet', (tester) async {
    final asset = RemoteAssetFactory.create(type: .video);
    await pumpDetails(tester, asset, const []);
    await tester.pumpAndSettle();

    expect(find.textContaining('No bookmarks yet'), findsOneWidget);
  });

  testWidgets('is hidden for photos', (tester) async {
    final asset = RemoteAssetFactory.create();
    await pumpDetails(tester, asset, const []);
    await tester.pumpAndSettle();

    expect(find.text('Bookmarks'), findsNothing);
    verifyNever(() => api.getAll(any()));
  });

  testWidgets('tapping a bookmark seeks, closes the sheet and plays from there', (tester) async {
    final asset = RemoteAssetFactory.create(type: .video);
    final hideEvents = <ViewerHideDetailsEvent>[];
    final subscription = EventStream.shared.listen<ViewerHideDetailsEvent>(hideEvents.add);
    addTearDown(subscription.cancel);
    await pumpDetails(tester, asset, [VideoBookmark(id: 'a', assetId: asset.id, time: 95000, label: 'Best part')]);
    await tester.pumpAndSettle();

    // The sheet opened on a paused video, which holds playback.
    player.markPaused();
    player.hold();
    await tester.pump();
    clearInteractions(controller);

    await tester.tap(find.text('Best part'));
    await tester.pump();

    expect(hideEvents, hasLength(1));
    expect(player.state.position, const Duration(seconds: 95));
    verifyInOrder([() => controller.seekTo(95000), controller.play]);

    // Closing the sheet releases the hold, which must not pause again.
    player.release();
    await tester.pump(const Duration(milliseconds: 200));
    verifyNever(controller.pause);
  });

  testWidgets('edit dialog: +/- move by a second, typed times are checked, save returns time and name', (tester) async {
    const bookmark = VideoBookmark(id: 'a', assetId: 'v', time: 95000, label: 'Best part');
    final moves = <int>[];
    ({int time, String label})? result;
    await tester.pumpConsumerWidget(
      Builder(
        builder: (context) => TextButton(
          onPressed: () async => result = await showDialog<({int time, String label})>(
            context: context,
            builder: (_) => EditVideoBookmarkDialog(bookmark: bookmark, maxTime: 150000, onTimeChanged: moves.add),
          ),
          child: const Text('open'),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    final timeField = find.widgetWithText(TextField, '1:35');
    expect(timeField, findsOneWidget);
    await tester.tap(find.byTooltip('One second later'));
    await tester.tap(find.byTooltip('One second later'));
    await tester.tap(find.byTooltip('One second earlier'));
    await tester.pump();
    expect(find.widgetWithText(TextField, '1:36'), findsOneWidget);
    expect(moves, [96000, 97000, 96000]);

    await tester.enterText(find.widgetWithText(TextField, '1:36'), 'abc');
    await tester.tap(find.text('Save'));
    await tester.pump();
    expect(find.text('Type a time like 1:05 or 1:02:03.'), findsOneWidget);
    expect(result, isNull);

    // past the end of the video is capped at its length
    await tester.enterText(find.widgetWithText(TextField, 'abc'), '9:00');
    await tester.enterText(find.widgetWithText(TextField, 'Best part'), 'Candles');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(result, (time: 150000, label: 'Candles'));
  });

  testWidgets('markers sit over the seek bar at the bookmarked share of the video', (tester) async {
    await tester.pumpConsumerWidget(
      const Center(
        child: SizedBox(
          width: 300,
          height: 20,
          child: VideoBookmarkMarkers(
            duration: Duration(seconds: 150),
            bookmarks: [
              VideoBookmark(id: 'a', assetId: 'v', time: 0, label: ''),
              VideoBookmark(id: 'b', assetId: 'v', time: 75000, label: ''),
              VideoBookmark(id: 'c', assetId: 'v', time: 150000, label: ''),
            ],
          ),
        ),
      ),
    );

    double left(String id) =>
        tester.getTopLeft(find.byKey(ValueKey(id))).dx - tester.getTopLeft(find.byType(VideoBookmarkMarkers)).dx;

    expect(left('a'), 0);
    expect(left('b'), 150 - 1.5);
    // the last marker stays inside the bar
    expect(left('c'), 300 - 3);
  });
}
