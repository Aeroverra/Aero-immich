import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_details/custom_fields_details.widget.dart';
import 'package:immich_mobile/providers/infrastructure/asset_metadata.provider.dart';
import 'package:immich_mobile/utils/asset_metadata.utils.dart';

import '../factories/local_asset_factory.dart';
import '../factories/remote_asset_factory.dart';
import 'presentation_context.dart';

void main() {
  late PresentationContext context;

  setUp(() async => context = await PresentationContext.create());
  tearDown(() => context.dispose());

  final List<AssetMetadataEntry> googlePhotos = [
    (
      key: 'google-photos',
      value: {
        'url': 'https://photos.google.com/photo/abc',
        'views': 42,
        'origin': 'mobileUpload',
        'people': ['Thomas', 'Nicholas Halka'],
      },
    ),
    (key: 'mobile-app', value: {'internal': 'secret'}),
  ];

  Future<void> pumpDetails(WidgetTester tester, Widget widget, List<AssetMetadataEntry> entries) =>
      tester.pumpTestWidget(
        context,
        SingleChildScrollView(child: widget),
        overrides: [assetMetadataProvider.overrideWith((ref, id) async => entries)],
      );

  group('CustomFieldsDetails', () {
    testWidgets('is collapsed by default and expands to show the rows', (tester) async {
      final asset = RemoteAssetFactory.create(ownerId: context.currentUser.id);
      await pumpDetails(tester, CustomFieldsDetails(asset: asset), googlePhotos);

      expect(find.text('Custom fields'), findsOneWidget);
      expect(find.text('Views'), findsNothing);
      expect(find.text('Open in Google Photos'), findsNothing);

      await tester.tap(find.text('Custom fields'));
      await tester.pumpAndSettle();

      expect(find.text('Views'), findsOneWidget);
      expect(find.text('42'), findsOneWidget);
      expect(find.text('Source'), findsOneWidget);
      expect(find.text('Phone backup'), findsOneWidget);
      expect(find.text('Tagged people'), findsOneWidget);
      expect(find.text('Thomas, Nicholas Halka'), findsOneWidget);
      expect(find.text('Open in Google Photos'), findsOneWidget);
      expect(find.text('Show raw data'), findsOneWidget);
      expect(find.textContaining('secret'), findsNothing);

      await tester.tap(find.text('Show raw data'));
      await tester.pumpAndSettle();

      expect(find.text('Hide raw data'), findsOneWidget);
      expect(find.byType(SelectableText), findsOneWidget);
      expect(find.textContaining('"views": 42'), findsOneWidget);
      expect(find.textContaining('secret'), findsNothing);

      await tester.tap(find.text('Custom fields'));
      await tester.pumpAndSettle();

      expect(find.text('Views'), findsNothing);
    });

    testWidgets('renders nothing when there is nothing to show', (tester) async {
      final asset = RemoteAssetFactory.create(ownerId: context.currentUser.id);
      await pumpDetails(tester, CustomFieldsDetails(asset: asset), [
        (key: 'mobile-app', value: {'internal': 'secret'}),
      ]);

      expect(find.byType(Text), findsNothing);
    });

    testWidgets('renders nothing for an asset owned by someone else', (tester) async {
      await pumpDetails(tester, CustomFieldsDetails(asset: RemoteAssetFactory.create()), googlePhotos);

      expect(find.byType(Text), findsNothing);
    });

    testWidgets('renders nothing for a local asset', (tester) async {
      await pumpDetails(tester, CustomFieldsDetails(asset: LocalAssetFactory.create()), googlePhotos);

      expect(find.byType(Text), findsNothing);
    });
  });
}
