import 'dart:async';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';

import '../../fixtures/asset.stub.dart';

void main() {
  final assets = List<BaseAsset>.generate(10, (i) => LocalAssetStub.image1.copyWith(id: 'a$i'));

  TimelineService createService(StreamController<List<Bucket>> buckets) => TimelineService((
    assetSource: (index, count) async =>
        assets.sublist(math.min(index, assets.length), math.min(index + count, assets.length)),
    bucketSource: () => buckets.stream,
    origin: TimelineOrigin.main,
  ));

  test('loadAssets answers before the buckets are counted', () async {
    final buckets = StreamController<List<Bucket>>();
    final service = createService(buckets);
    addTearDown(service.dispose);

    final loaded = await service.loadAssets(4, 3);

    expect(loaded.map((asset) => asset.id), ['a4', 'a5', 'a6']);
  });

  test('loadAssets returns what exists for a range left over from a larger timeline', () async {
    final buckets = StreamController<List<Bucket>>();
    final service = createService(buckets);
    addTearDown(service.dispose);
    buckets.add([const Bucket(assetCount: 10)]);
    await pumpEventQueue();

    expect((await service.loadAssets(8, 4)).map((asset) => asset.id), ['a8', 'a9']);
    expect(await service.loadAssets(40, 4), isEmpty);
  });

  test('fetchAssets reads from the source without replacing the buffer', () async {
    final buckets = StreamController<List<Bucket>>();
    final service = createService(buckets);
    addTearDown(service.dispose);
    buckets.add([const Bucket(assetCount: 10)]);
    await pumpEventQueue();
    expect(service.hasRange(0, 10), isTrue);

    expect((await service.fetchAssets(2, 2)).map((asset) => asset.id), ['a2', 'a3']);
    expect(service.hasRange(0, 10), isTrue);
  });
}
