import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/utils/action_button.utils.dart';

/// Stands in for the page the viewer was opened from (the search results). It keeps its own state so
/// the test can prove the page is neither rebuilt nor recreated by the jump.
class _OriginPage extends StatefulWidget {
  const _OriginPage();

  @override
  State<_OriginPage> createState() => _OriginPageState();
}

class _OriginPageState extends State<_OriginPage> {
  final controller = TextEditingController();

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: TextField(key: const Key('query'), controller: controller),
    );
  }
}

class _ViewerPage extends StatelessWidget {
  final ActionButtonContext actionContext;

  const _ViewerPage({required this.actionContext});

  @override
  Widget build(BuildContext context) {
    return Scaffold(body: ActionButtonType.viewInTimeline.buildButton(actionContext, context, false, true));
  }
}

class _TimelinePage extends StatelessWidget {
  final MainTimelineRouteArgs args;

  const _TimelinePage({required this.args});

  @override
  Widget build(BuildContext context) {
    return Scaffold(body: Text('timeline ${args.scrollToDate?.toIso8601String()}'));
  }
}

void main() {
  const originRouteName = 'OriginRoute';
  const viewerRouteName = 'ViewerRoute';

  final asset = RemoteAsset(
    id: 'remote-id',
    name: 'beach.jpg',
    checksum: 'checksum',
    type: AssetType.image,
    ownerId: 'owner-id',
    createdAt: DateTime.utc(2024, 6, 15, 23, 30),
    updatedAt: DateTime.utc(2024, 6, 15, 23, 30),
    uploadedAt: DateTime.utc(2024, 6, 16),
    isFavorite: false,
    isEdited: false,
  );

  final actionContext = ActionButtonContext(
    asset: asset,
    isOwner: true,
    isArchived: false,
    isTrashEnabled: true,
    isInLockedView: false,
    currentAlbum: null,
    advancedTroubleshooting: false,
    isStacked: false,
    source: ActionSource.viewer,
    timelineOrigin: TimelineOrigin.search,
  );

  late RootStackRouter router;

  setUp(() {
    router = RootStackRouter.build(
      routes: [
        AutoRoute(initial: true, page: PageInfo(originRouteName, builder: (_) => const _OriginPage())),
        AutoRoute(
          path: '/viewer',
          page: PageInfo(viewerRouteName, builder: (_) => _ViewerPage(actionContext: actionContext)),
        ),
        AutoRoute(
          path: '/timeline',
          page: PageInfo(
            MainTimelineRoute.name,
            builder: (data) => _TimelinePage(args: data.argsAs<MainTimelineRouteArgs>()),
          ),
        ),
      ],
    );
  });

  List<String> stackNames() => router.stackData.map((data) => data.name).toList();

  Future<_OriginPageState> pumpAppWithViewerOpen(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp.router(routerConfig: router.config()));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('query')), 'sunrise on the beach');
    final originState = tester.state<_OriginPageState>(find.byType(_OriginPage));

    unawaited(router.pushPath('/viewer'));
    await tester.pumpAndSettle();
    expect(stackNames(), [originRouteName, viewerRouteName]);

    return originState;
  }

  testWidgets('view in timeline swaps the viewer for a timeline pushed above the origin page', (tester) async {
    await pumpAppWithViewerOpen(tester);

    await tester.tap(find.byType(MenuItemButton));
    await tester.pumpAndSettle();

    expect(stackNames(), [originRouteName, MainTimelineRoute.name]);
  });

  testWidgets('the pushed timeline receives the asset date in local time', (tester) async {
    await pumpAppWithViewerOpen(tester);

    await tester.tap(find.byType(MenuItemButton));
    await tester.pumpAndSettle();

    final args = router.stackData.last.argsAs<MainTimelineRouteArgs>();
    expect(args.scrollToDate, asset.createdAt.toLocal());
    expect(args.scrollToDate!.isUtc, isFalse);
    expect(find.text('timeline ${asset.createdAt.toLocal().toIso8601String()}'), findsOneWidget);
  });

  testWidgets('back from the timeline returns to the origin page with its state untouched', (tester) async {
    final originState = await pumpAppWithViewerOpen(tester);

    await tester.tap(find.byType(MenuItemButton));
    await tester.pumpAndSettle();
    // The origin page stays mounted underneath the timeline instead of being disposed by a tab switch
    expect(find.byType(_OriginPage, skipOffstage: false), findsOneWidget);
    expect(tester.state<_OriginPageState>(find.byType(_OriginPage, skipOffstage: false)), same(originState));

    await router.maybePop();
    await tester.pumpAndSettle();

    expect(stackNames(), [originRouteName]);
    expect(tester.state<_OriginPageState>(find.byType(_OriginPage)), same(originState));
    expect(originState.controller.text, 'sunrise on the beach');
    expect(find.text('sunrise on the beach'), findsOneWidget);
  });

  testWidgets('the button is disabled without a build context to navigate from', (tester) async {
    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: ActionButtonType.viewInTimeline.buildButton(actionContext, null, false, true))),
    );

    expect(tester.widget<MenuItemButton>(find.byType(MenuItemButton)).onPressed, isNull);
  });
}
