import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_details/uploaded_details.widget.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/repositories/asset_api.repository.dart';
import 'package:mocktail/mocktail.dart';

import '../../../repository.mocks.dart';
import '../../../test_utils.dart';
import '../../../widget_tester_extensions.dart';

/// The viewer with its details sheet open or closed, without an asset behind it
class _TestAssetViewerNotifier extends AssetViewerStateNotifier {
  final bool showingDetails;

  _TestAssetViewerNotifier({required this.showingDetails});

  @override
  AssetViewerState build() => AssetViewerState(showingDetails: showingDetails);
}

void main() {
  late MockAssetApiRepository assetApi;
  final remote = TestUtils.createRemoteAsset(id: 'remote-1');

  setUpAll(TestUtils.init);

  setUp(() => assetApi = MockAssetApiRepository());

  Future<void> pump(WidgetTester tester, BaseAsset asset, {bool showingDetails = true}) {
    return tester.pumpConsumerWidget(
      UploadedDetails(asset: asset),
      overrides: [
        assetApiRepositoryProvider.overrideWithValue(assetApi),
        assetViewerProvider.overrideWith(() => _TestAssetViewerNotifier(showingDetails: showingDetails)),
      ],
    );
  }

  void answer(AssetUploadDates dates) => when(() => assetApi.uploadDates(any())).thenAnswer((_) async => dates);

  testWidgets('a Google Photos import shows its upload date and the day it reached Immich', (tester) async {
    answer((uploadedAt: DateTime(2015, 6, 1, 14, 30), createdAt: DateTime(2024, 3, 5, 9)));

    await pump(tester, remote);

    expect(find.byIcon(Icons.cloud_upload_outlined), findsOneWidget);
    expect(find.textContaining('Uploaded'), findsOneWidget);
    expect(find.textContaining('Mon, Jun 1, 2015'), findsOneWidget);
    expect(find.text('Added to Immich Mar 5, 2024'), findsOneWidget);
    verify(() => assetApi.uploadDates('remote-1')).called(1);
  });

  testWidgets('an asset uploaded to Immich directly shows one date', (tester) async {
    answer((uploadedAt: DateTime(2024, 3, 5, 9), createdAt: DateTime(2024, 3, 5, 9)));

    await pump(tester, remote);

    expect(find.textContaining('Tue, Mar 5, 2024'), findsOneWidget);
    expect(find.textContaining('Added to Immich'), findsNothing);
  });

  testWidgets('shows nothing for an asset only on the device', (tester) async {
    await pump(tester, TestUtils.createLocalAsset(id: 'local-1'));

    expect(find.byIcon(Icons.cloud_upload_outlined), findsNothing);
    verifyNever(() => assetApi.uploadDates(any()));
  });

  testWidgets('asks the server only once the details are open', (tester) async {
    await pump(tester, remote, showingDetails: false);

    expect(find.byIcon(Icons.cloud_upload_outlined), findsNothing);
    verifyNever(() => assetApi.uploadDates(any()));
  });

  testWidgets('shows nothing when the server cannot say', (tester) async {
    when(() => assetApi.uploadDates(any())).thenAnswer((_) async => throw Exception('offline'));

    await pump(tester, remote);

    expect(find.byIcon(Icons.cloud_upload_outlined), findsNothing);
  });
}
