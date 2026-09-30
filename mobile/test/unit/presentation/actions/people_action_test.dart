import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/people.action.dart';
import 'package:immich_mobile/providers/infrastructure/user_metadata.provider.dart';
import 'package:immich_ui/immich_ui.dart';

import '../../factories/remote_asset_factory.dart';
import '../presentation_context.dart';

void main() {
  late PresentationContext context;

  setUp(() async {
    context = await PresentationContext.create();
  });

  tearDown(() async {
    await context.dispose();
  });

  Future<void> pumpAction(WidgetTester tester, Set<BaseAsset> selection, {bool peopleEnabled = true}) =>
      tester.pumpTestWidget(
        context,
        const ActionIconButton(action: PeopleAction(source: .timeline)),
        overrides: [
          ...context.selected(selection),
          userMetadataPreferencesProvider.overrideWith((ref) async => .new(peopleEnabled: peopleEnabled)),
        ],
      );

  testWidgets('is offered for owned photos', (tester) async {
    await pumpAction(tester, {RemoteAssetFactory.create(ownerId: context.currentUser.id)});

    expect(find.byType(ImmichIconButton), findsOneWidget);
  });

  testWidgets('is offered for owned videos', (tester) async {
    await pumpAction(tester, {RemoteAssetFactory.create(ownerId: context.currentUser.id, type: .video)});

    expect(find.byType(ImmichIconButton), findsOneWidget);
  });

  testWidgets('is hidden for assets of other users', (tester) async {
    await pumpAction(tester, {RemoteAssetFactory.create(type: .video)});

    expect(find.byType(ImmichIconButton), findsNothing);
  });

  testWidgets('is hidden when people are turned off', (tester) async {
    await pumpAction(tester, {RemoteAssetFactory.create(ownerId: context.currentUser.id)}, peopleEnabled: false);

    expect(find.byType(ImmichIconButton), findsNothing);
  });
}
