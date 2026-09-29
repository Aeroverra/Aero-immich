import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/domain/services/people.service.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/add_people.action.dart';
import 'package:immich_mobile/providers/background_sync.provider.dart';
import 'package:immich_mobile/providers/infrastructure/people.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:mocktail/mocktail.dart';

import '../../factories/remote_asset_factory.dart';
import '../presentation_context.dart';

class _MockPeopleService extends Mock implements PeopleService {}

void main() {
  late PresentationContext context;
  late _MockPeopleService peopleService;
  late BuildContext actionContext;
  late WidgetRef actionRef;

  const ann = Person(id: 'ann', name: 'Ann');
  const unnamed = Person(id: 'unnamed', name: '');

  setUp(() async {
    context = await PresentationContext.create();
    peopleService = _MockPeopleService();
    when(() => context.service.backgroundSync.syncRemote()).thenAnswer((_) async => true);
  });

  tearDown(() async {
    await context.dispose();
  });

  RemoteAsset video() => RemoteAssetFactory.create(ownerId: context.currentUser.id, type: .video);
  RemoteAsset photo() => RemoteAssetFactory.create(ownerId: context.currentUser.id);

  Future<void> pumpAction(WidgetTester tester, Set<BaseAsset> selection, {bool peopleEnabled = true}) =>
      tester.pumpTestWidget(
        context,
        Consumer(
          builder: (widgetContext, ref, _) {
            actionContext = widgetContext;
            actionRef = ref;
            return const ActionIconButton(action: AddPeopleAction(source: .timeline));
          },
        ),
        overrides: [
          ...context.selected(selection),
          toastServiceProvider.overrideWithValue(context.service.toast),
          peopleServiceProvider.overrideWithValue(peopleService),
          backgroundSyncProvider.overrideWithValue(context.service.backgroundSync),
          userMetadataPreferencesProvider.overrideWith((ref) async => .new(peopleEnabled: peopleEnabled)),
        ],
      );

  testWidgets('is offered when an owned video is selected', (tester) async {
    await pumpAction(tester, {video(), photo()});

    expect(find.byType(ImmichIconButton), findsOneWidget);
  });

  testWidgets('is hidden when only photos are selected', (tester) async {
    await pumpAction(tester, {photo()});

    expect(find.byType(ImmichIconButton), findsNothing);
  });

  testWidgets('is hidden for videos of other users', (tester) async {
    await pumpAction(tester, {RemoteAssetFactory.create(type: .video)});

    expect(find.byType(ImmichIconButton), findsNothing);
  });

  testWidgets('is hidden when people are turned off', (tester) async {
    await pumpAction(tester, {video()}, peopleEnabled: false);

    expect(find.byType(ImmichIconButton), findsNothing);
  });

  testWidgets('adds the people, reports the videos and the skipped photos and syncs', (tester) async {
    when(
      () => peopleService.addToVideos(any(), any()),
    ).thenAnswer((_) async => (added: {'video-1', 'video-2'}, photos: {'photo-1'}));

    await pumpAction(tester, {video()});
    final added = await addPeopleToVideos(actionContext, actionRef, ['video-1', 'video-2', 'photo-1'], {ann, unnamed});
    await tester.pumpAndSettle();

    expect(added, isTrue);
    final personIds = verify(() => peopleService.addToVideos(captureAny(), ['video-1', 'video-2', 'photo-1'])).captured;
    expect((personIds.single as Iterable<String>).toList(), ['ann', 'unnamed']);
    final success = verify(() => context.service.toast.success(captureAny())).captured.single as String;
    final names = 'Ann, ${StaticTranslations.instance.no_name}';
    expect(success, StaticTranslations.instance.added_people_to_videos(people: names, count: 2));
    final info = verify(() => context.service.toast.info(captureAny())).captured.single as String;
    expect(info, StaticTranslations.instance.add_people_to_videos_photos_skipped(count: 1));
    verify(() => context.service.backgroundSync.syncRemote()).called(1);
  });

  testWidgets('says so when the videos already have the people', (tester) async {
    when(
      () => peopleService.addToVideos(any(), any()),
    ).thenAnswer((_) async => (added: <String>{}, photos: <String>{}));

    await pumpAction(tester, {video()});
    final added = await addPeopleToVideos(actionContext, actionRef, ['video-1'], {ann});
    await tester.pumpAndSettle();

    expect(added, isFalse);
    final info = verify(() => context.service.toast.info(captureAny())).captured.single as String;
    expect(info, StaticTranslations.instance.add_people_to_videos_none_added);
    verifyNever(() => context.service.toast.success(any()));
    verifyNever(() => context.service.backgroundSync.syncRemote());
  });
}
