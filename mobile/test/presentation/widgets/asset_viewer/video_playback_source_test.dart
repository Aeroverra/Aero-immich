import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/providers/asset_viewer/video_player_provider.dart';
import 'package:immich_mobile/services/gcast.service.dart';
import 'package:immich_mobile/widgets/asset_viewer/video_controls.dart';

import '../../../service.mocks.dart';
import '../../../widget_tester_extensions.dart';

void main() {
  const playerName = 'video-1';

  Future<WidgetRef> pumpControls(WidgetTester tester) async {
    late WidgetRef ref;
    await tester.pumpConsumerWidget(
      Consumer(
        builder: (context, widgetRef, _) {
          ref = widgetRef;
          return const VideoControls(videoPlayerName: playerName);
        },
      ),
      overrides: [gCastServiceProvider.overrideWithValue(MockGCastService())],
    );
    return ref;
  }

  testWidgets('no label until the player knows its source', (tester) async {
    await pumpControls(tester);

    expect(find.byType(VideoPlaybackSourceChip), findsNothing);
  });

  testWidgets('label follows the source the player picked', (tester) async {
    final ref = await pumpControls(tester);
    final notifier = ref.read(videoPlayerProvider(playerName).notifier);

    notifier.setSource(VideoPlaybackSource.transcoded);
    await tester.pump();
    expect(find.text('Transcoded'), findsOneWidget);

    notifier.setSource(VideoPlaybackSource.original);
    await tester.pump();
    expect(find.text('Original'), findsOneWidget);

    notifier.setSource(VideoPlaybackSource.device);
    await tester.pump();
    expect(find.text('On device'), findsOneWidget);
  });

  testWidgets('label names the resolution by its short side', (tester) async {
    await tester.pumpConsumerWidget(
      const VideoPlaybackSourceChip(source: VideoPlaybackSource.transcoded, resolution: 720),
    );

    expect(find.text('Transcoded · 720p'), findsOneWidget);
  });

  testWidgets('tapping the label explains it', (tester) async {
    await tester.pumpConsumerWidget(const VideoPlaybackSourceChip(source: VideoPlaybackSource.transcoded));

    await tester.tap(find.byType(VideoPlaybackSourceChip));
    await tester.pumpAndSettle();

    expect(find.text('Playing a smaller transcoded copy instead of the original file'), findsOneWidget);
  });
}
