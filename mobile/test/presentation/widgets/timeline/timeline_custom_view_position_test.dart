import 'dart:math' as math;

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/config/app_config.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/domain/services/user.service.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/timeline.repository.dart';
import 'package:immich_mobile/presentation/widgets/images/thumbnail_tile.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/settings.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/repositories/custom_view_api.repository.dart';
import 'package:mocktail/mocktail.dart';

import '../../../infrastructure/repository.mock.dart';
import '../../../test_utils.dart';

class _MockTimelineRepository extends Mock implements TimelineRepository {}

class _MockSettingsRepository extends Mock implements SettingsRepository {}

class _MockUserService extends Mock implements UserService {}

class _MockCustomViewApiRepository extends Mock implements CustomViewApiRepository {}

class _TestPrivateModeNotifier extends PrivateModeNotifier {
  _TestPrivateModeNotifier(super.ref);

  @override
  Future<void> refresh() async {}
}

const _userId = 'user-1';
const _vetted = CustomView(id: 'vetted', ownerId: _userId, name: 'Vetted', isDefault: true);
const _everything = CustomView(id: 'everything', ownerId: _userId, name: 'Everything', order: 1);

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

  testWidgets('switching views keeps the same photos at the top of the main timeline', (tester) async {
    tester.view.devicePixelRatio = 3.0;
    tester.view.physicalSize = const Size(1206, 2622);
    addTearDown(tester.view.reset);

    // 30 days of 60 photos; the default view hides every third one
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
            isEdited: false,
          ),
    ];
    bool hiddenByDefault(String id) => int.parse(id.split('-').last) % 3 == 1;
    final vetted = all.where((asset) => !hiddenByDefault(asset.id)).toList();
    int indexOf(String id) => all.indexWhere((asset) => asset.id == id);

    final viewsSeen = <String?>[];
    final timelineRepository = _MockTimelineRepository();
    when(
      () => timelineRepository.main(
        any(),
        any(),
        privateFilter: any(named: 'privateFilter'),
        groupAutoStacks: any(named: 'groupAutoStacks'),
      ),
    ).thenAnswer((invocation) {
      final viewId = (invocation.namedArguments[#privateFilter] as PrivateModeFilter).view?.viewId;
      viewsSeen.add(viewId);
      final assets = viewId == _vetted.id ? vetted : all;
      return (
        assetSource: (index, count) async =>
            assets.sublist(math.min(index, assets.length), math.min(index + count, assets.length)),
        bucketSource: () => Stream.value(_buckets(assets)),
        origin: TimelineOrigin.main,
      );
    });

    final api = _MockCustomViewApiRepository();
    when(
      () => api.setActive(any(), pinCode: any(named: 'pinCode')),
    ).thenAnswer((invocation) async => ActiveCustomView(viewId: invocation.positionalArguments.first as String?));

    final drift = MockDrift();
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
          privateModeProvider.overrideWith(_TestPrivateModeNotifier.new),
          customViewsSupportedProvider.overrideWithValue(true),
          localViewsProvider.overrideWith((ref) => Stream.value(const [_vetted, _everything])),
          localTagsProvider.overrideWith((ref) => Stream.value(const [])),
          customViewApiRepositoryProvider.overrideWithValue(api),
          timelineUsersProvider.overrideWith((ref) => Stream.value([_userId])),
        ],
        child: MaterialApp.router(routerConfig: router.config()),
      ),
    );
    await _settle(tester);

    final container = ProviderScope.containerOf(tester.element(find.byType(Timeline)));
    final activeView = container.read(activeViewProvider.notifier);
    // what the switcher does
    await activeView.switchTo(_everything);
    await _settle(tester);
    expect(viewsSeen.last, _everything.id);

    final scrollable = find.descendant(of: find.byType(Timeline), matching: find.byType(Scrollable)).first;
    ScrollPosition position() => tester.state<ScrollableState>(scrollable).position;
    final viewportTop = tester.getRect(scrollable).top;

    // deep into the timeline with a photo the default view hides as the first photo of the top row
    var hidden = (id: '', top: 0.0);
    for (double offset = 30000; hidden.id.isEmpty || !hiddenByDefault(hidden.id); offset += 41) {
      position().jumpTo(offset);
      await _settle(tester);
      hidden = _topTile(tester, viewportTop);
    }

    // back to the default view: the hidden photo is gone, a neighbour taken right before or after it takes its place
    await activeView.switchTo(_vetted);
    await _settle(tester);
    expect(viewsSeen.last, _vetted.id);
    expect(_tile(tester, hidden.id), isNull);
    final vettedTop = _topTile(tester, viewportTop);
    final neighbours = [all[indexOf(hidden.id) - 1].id, all[indexOf(hidden.id) + 1].id];
    final neighbourTops = [for (final id in neighbours) _tile(tester, id)?.top];
    expect(
      neighbourTops.any((top) => top != null && (top - hidden.top).abs() < 0.5),
      isTrue,
      reason: 'a photo taken right before or after the hidden one is in the row where it was',
    );

    // and to the view that shows everything again: the photo at the top stays where it is
    await activeView.switchTo(_everything);
    await _settle(tester);
    final everythingTop = _tile(tester, vettedTop.id);
    expect(everythingTop, isNotNull);
    expect(everythingTop!.top, closeTo(vettedTop.top, 0.5));

    // several switches do not drift
    for (int i = 0; i < 3; i++) {
      await activeView.switchTo(_vetted);
      await _settle(tester);
      await activeView.switchTo(_everything);
      await _settle(tester);
    }
    expect(_tile(tester, vettedTop.id)?.top, closeTo(vettedTop.top, 0.5));
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
