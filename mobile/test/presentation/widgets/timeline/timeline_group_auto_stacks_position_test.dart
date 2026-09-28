import 'dart:async';
import 'dart:math' as math;

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/config/app_config.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/models/user_metadata.model.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/domain/services/user.service.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/timeline.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/user_metadata.repository.dart';
import 'package:immich_mobile/presentation/widgets/images/thumbnail_tile.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user.provider.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:mocktail/mocktail.dart';

import '../../../infrastructure/repository.mock.dart';
import '../../../test_utils.dart';

class _MockTimelineRepository extends Mock implements TimelineRepository {}

class _MockSettingsRepository extends Mock implements SettingsRepository {}

class _MockUserService extends Mock implements UserService {}

class _MockUserMetadataRepository extends Mock implements UserMetadataRepository {}

const _userId = 'user-1';

List<TimeBucket> _buckets(List<BaseAsset> assets) {
  final buckets = <TimeBucket>[];
  for (final asset in assets) {
    final day = DateTime(asset.createdAt.year, asset.createdAt.month, asset.createdAt.day);
    if (buckets.isNotEmpty && buckets.last.date == day) {
      buckets[buckets.length - 1] = TimeBucket(date: day, assetCount: buckets.last.assetCount + 1);
    } else {
      buckets.add(TimeBucket(date: day, assetCount: 1));
    }
  }
  return buckets;
}

void main() {
  setUpAll(() {
    TestUtils.init();
    registerFallbackValue(GroupAssetsBy.day);
    registerFallbackValue(PrivateModeFilter.off);
  });

  testWidgets('the automatic stacks toggle keeps the same photos at the top of the main timeline', (tester) async {
    tester.view.devicePixelRatio = 3.0;
    tester.view.physicalSize = const Size(1206, 2622);
    addTearDown(tester.view.reset);

    // 30 days of 60 photos, every three consecutive photos form an automatic stack with the first as its cover
    final all = <RemoteAsset>[
      for (int day = 30; day >= 1; day--)
        for (int i = 0; i < 60; i++)
          RemoteAsset(
            id: 'd$day-$i',
            name: 'd$day-$i.jpg',
            ownerId: _userId,
            checksum: 'checksum-d$day-$i',
            type: AssetType.image,
            createdAt: DateTime(2024, 1, day, 20).subtract(Duration(minutes: i)),
            updatedAt: DateTime(2024, 1, day, 20),
            stackId: 'stack-d$day-${i ~/ 3}',
            isEdited: false,
          ),
    ];
    final grouped = [
      for (int i = 0; i < all.length; i++)
        if (i % 3 == 0) all[i],
    ];
    String coverOf(String id) => all[all.indexWhere((asset) => asset.id == id) ~/ 3 * 3].id;

    final timelineRepository = _MockTimelineRepository();
    when(
      () => timelineRepository.main(
        any(),
        any(),
        privateFilter: any(named: 'privateFilter'),
        groupAutoStacks: any(named: 'groupAutoStacks'),
      ),
    ).thenAnswer((invocation) {
      final assets = invocation.namedArguments[#groupAutoStacks] as bool ? grouped : all;
      return (
        assetSource: (index, count) async =>
            assets.sublist(math.min(index, assets.length), math.min(index + count, assets.length)),
        bucketSource: () => Stream.value(_buckets(assets)),
        origin: TimelineOrigin.main,
      );
    });

    final preferences = StreamController<Preferences?>();
    addTearDown(preferences.close);
    // the user shows automatic stacks one by one
    preferences.add(const Preferences(groupAutoStacks: false));
    final userMetadata = _MockUserMetadataRepository();
    when(() => userMetadata.watchPreferences(_userId)).thenAnswer((_) => preferences.stream);
    when(() => userMetadata.setGroupAutoStacks(_userId, any())).thenAnswer((invocation) async {
      preferences.add(Preferences(groupAutoStacks: invocation.positionalArguments[1] as bool));
    });
    final userApi = MockUserApiRepository();
    when(() => userApi.updateGroupAutoStacks(any())).thenAnswer((_) async {});

    final drift = MockDrift();
    when(() => drift.userMetadataRepository).thenReturn(userMetadata);
    when(() => drift.timelineRepository).thenReturn(timelineRepository);
    final settings = _MockSettingsRepository();
    when(() => settings.appConfig).thenReturn(const AppConfig());
    final userService = _MockUserService();
    when(
      () => userService.tryGetMyUser(),
    ).thenReturn(UserDto(id: _userId, email: 'user@test.dev', name: 'user', profileChangedAt: DateTime(2026)));
    when(() => userService.watchMyUser()).thenAnswer((_) => const Stream.empty());

    final router = RootStackRouter.build(
      routes: [
        AutoRoute(
          initial: true,
          page: PageInfo(
            'Timeline',
            builder: (_) => const Timeline(
              withScrubber: false,
              readOnly: true,
              groupBy: GroupAssetsBy.none,
              appBar: SliverToBoxAdapter(child: SizedBox(height: 56)),
            ),
          ),
        ),
      ],
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          appConfigProvider.overrideWithValue(const AppConfig()),
          settingsProvider.overrideWithValue(settings),
          driftProvider.overrideWithValue(drift),
          currentUserProvider.overrideWith((ref) => CurrentUserProvider(userService)),
          userApiRepositoryProvider.overrideWithValue(userApi),
          privateModeFilterProvider.overrideWithValue(PrivateModeFilter.off),
          timelineUsersProvider.overrideWith((ref) => Stream.value([_userId])),
        ],
        child: MaterialApp.router(routerConfig: router.config()),
      ),
    );
    await _settle(tester);

    final scrollable = find.descendant(of: find.byType(Timeline), matching: find.byType(Scrollable)).first;
    ScrollPosition position() => tester.state<ScrollableState>(scrollable).position;
    final viewportTop = tester.getRect(scrollable).top;

    // deep into the timeline with a stack member (not a cover) as the first photo of the top row
    var member = (id: '', top: 0.0);
    for (double offset = 30000; member.id.isEmpty || coverOf(member.id) == member.id; offset += 41) {
      position().jumpTo(offset);
      await _settle(tester);
      member = _topTile(tester, viewportTop);
    }

    // what the top bar button does
    final container = ProviderScope.containerOf(tester.element(find.byType(Timeline)));
    final updateGroupAutoStacks = container.read(updateGroupAutoStacksProvider);

    // group: the member is hidden, its cover takes its place
    await updateGroupAutoStacks(true);
    await _settle(tester);
    verify(() => userApi.updateGroupAutoStacks(true)).called(1);
    final cover = _tile(tester, coverOf(member.id));
    expect(_tile(tester, member.id), isNull);
    expect(cover, isNotNull, reason: 'the cover of the stack the top photo belongs to is on screen');
    expect(cover!.top, closeTo(member.top, 0.5), reason: 'where the member was');

    // show them one by one again: the cover now first in the top row stays where it is
    final groupedTop = _topTile(tester, viewportTop);
    await updateGroupAutoStacks(false);
    await _settle(tester);
    verify(() => userApi.updateGroupAutoStacks(false)).called(1);
    final ungroupedTop = _tile(tester, groupedTop.id);
    expect(ungroupedTop, isNotNull);
    expect(ungroupedTop!.top, closeTo(groupedTop.top, 0.5));
    expect(_topTile(tester, viewportTop).id, groupedTop.id);
  });
}

Future<void> _settle(WidgetTester tester) async {
  for (int i = 0; i < 20; i++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  // remote thumbnails cannot load in tests
  while (tester.takeException() != null) {}
}

({String id, double top}) _topTile(WidgetTester tester, double viewportTop) {
  final tiles = tester
      .widgetList<ThumbnailTile>(find.byType(ThumbnailTile))
      .map((tile) {
        final rect = tester.getRect(find.byWidget(tile));
        return (id: tile.asset!.id, top: rect.top, left: rect.left, bottom: rect.bottom);
      })
      .where((tile) => tile.bottom > viewportTop);
  final top = tiles.reduce((a, b) => a.top < b.top || (a.top == b.top && a.left < b.left) ? a : b);
  return (id: top.id, top: top.top);
}

({String id, double top})? _tile(WidgetTester tester, String id) {
  for (final tile in tester.widgetList<ThumbnailTile>(find.byType(ThumbnailTile))) {
    if (tile.asset?.id == id) {
      return (id: id, top: tester.getRect(find.byWidget(tile)).top);
    }
  }
  return null;
}
