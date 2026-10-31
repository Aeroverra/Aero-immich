import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/providers/asset_viewer/video_player_provider.dart';
import 'package:immich_mobile/services/gcast.service.dart';
import 'package:immich_mobile/widgets/asset_viewer/video_controls.dart';
import 'package:mocktail/mocktail.dart';
import 'package:native_video_player/native_video_player.dart';

import '../../../service.mocks.dart';
import '../../../widget_tester_extensions.dart';

class _MockNativeVideoPlayerController extends Mock implements NativeVideoPlayerController {}

class _TestVideoPlayerNotifier extends VideoPlayerNotifier {
  void markPlaying(Duration duration) =>
      state = state.copyWith(status: VideoPlaybackStatus.playing, duration: duration);
}

void main() {
  const playerName = 'video-1';
  late _MockNativeVideoPlayerController controller;
  late _TestVideoPlayerNotifier player;

  setUp(() {
    controller = _MockNativeVideoPlayerController();
    when(controller.play).thenAnswer((_) async {});
    when(controller.pause).thenAnswer((_) async {});
    when(() => controller.seekTo(any())).thenAnswer((_) async {});
    player = _TestVideoPlayerNotifier()..attachController(controller);
  });

  Future<void> pumpControls(WidgetTester tester, {Duration? searchMatch}) async {
    await tester.pumpConsumerWidget(
      VideoControls(videoPlayerName: playerName, searchMatch: searchMatch),
      overrides: [
        videoPlayerProvider.overrideWith((ref, id) => player),
        gCastServiceProvider.overrideWithValue(MockGCastService()),
      ],
    );
  }

  testWidgets('shows nothing about search for a video that did not match on a frame', (tester) async {
    await pumpControls(tester);
    player.markPlaying(const Duration(minutes: 3));
    await tester.pump();

    expect(find.byType(VideoSearchMatchChip), findsNothing);
    expect(find.byType(VideoSearchMatchMarker), findsNothing);
  });

  testWidgets('shows where the search matched and pauses there on tap', (tester) async {
    await pumpControls(tester, searchMatch: const Duration(seconds: 83));
    player.markPlaying(const Duration(minutes: 3));
    await tester.pump();

    expect(find.text('Match at 01:23'), findsOneWidget);
    expect(find.byType(VideoSearchMatchMarker), findsOneWidget);

    await tester.tap(find.byType(VideoSearchMatchChip));
    await tester.pump(const Duration(milliseconds: 200));

    expect(player.state.position, const Duration(seconds: 83));
    verifyInOrder([controller.pause, () => controller.seekTo(83000)]);
    verifyNever(controller.play);
  });

  testWidgets('the marker sits over the seek bar at the matching share of the video', (tester) async {
    Future<double> left(Duration position) async {
      await tester.pumpConsumerWidget(
        Center(
          child: SizedBox(
            width: 300,
            height: 20,
            child: VideoSearchMatchMarker(position: position, duration: const Duration(seconds: 150)),
          ),
        ),
      );
      return tester.getTopLeft(find.byKey(const ValueKey('search-match'))).dx -
          tester.getTopLeft(find.byType(VideoSearchMatchMarker)).dx;
    }

    expect(await left(Duration.zero), 0);
    expect(await left(const Duration(seconds: 75)), 150 - 4.5);
    // the end stays inside the bar
    expect(await left(const Duration(seconds: 150)), 300 - 9);
  });
}
