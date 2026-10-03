import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/presentation/widgets/timeline/fixed/segment_builder.dart';
import 'package:immich_mobile/presentation/widgets/timeline/segment.model.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline_scroll_anchor.dart';

const _tileHeight = 100.0;
const _spacing = 2.0;

RemoteAsset _asset(String id, DateTime createdAt, {String? stackId}) => RemoteAsset(
  id: id,
  name: '$id.jpg',
  ownerId: 'owner',
  checksum: 'checksum-$id',
  type: AssetType.image,
  createdAt: createdAt,
  updatedAt: createdAt,
  stackId: stackId,
  isEdited: false,
);

/// 30 days with 20 photos each, newest first, one minute apart
List<RemoteAsset> _library() => [
  for (int day = 30; day >= 1; day--)
    for (int i = 0; i < 20; i++) _asset('d$day-$i', DateTime(2024, 1, day, 20).subtract(Duration(minutes: i))),
];

DateTime _day(DateTime date) => DateTime(date.year, date.month, date.day);

List<Segment> _segments(List<BaseAsset> assets, {int columnCount = 4, double tileHeight = _tileHeight}) {
  final buckets = <TimeBucket>[];
  for (final asset in assets) {
    final day = _day(asset.createdAt);
    if (buckets.isNotEmpty && buckets.last.date == day) {
      buckets[buckets.length - 1] = TimeBucket(date: day, assetCount: buckets.last.assetCount + 1);
    } else {
      buckets.add(TimeBucket(date: day, assetCount: 1));
    }
  }
  return FixedSegmentBuilder(
    buckets: buckets,
    tileHeight: tileHeight,
    columnCount: columnCount,
    spacing: _spacing,
    groupBy: GroupAssetsBy.day,
  ).generate();
}

TimelineAnchorAssetLoader _loader(List<BaseAsset> assets) =>
    (index, count) async => assets.sublist(math.min(index, assets.length), math.min(index + count, assets.length));

/// Scroll offset at which the row holding [assets][index] starts, plus [offsetInRow]
double _offsetOf(List<Segment> segments, List<BaseAsset> assets, String id, int columnCount, {double offsetInRow = 0}) {
  final index = assets.indexWhere((asset) => asset.id == id);
  final segment = segments.lastWhere((segment) => segment.firstAssetIndex <= index);
  final row = segment.gridIndex + (index - segment.firstAssetIndex) ~/ columnCount;
  return segment.indexToLayoutOffset(row) + offsetInRow;
}

TimelineScrollAnchor _capture(List<Segment> segments, List<BaseAsset> assets, double offset, {int columnCount = 4}) =>
    TimelineScrollAnchor.capture(
      segments: segments,
      scrollOffset: offset,
      columnCount: columnCount,
      assetAt: (index) => index < assets.length ? assets[index] : null,
    )!;

void main() {
  group('TimelineScrollAnchor', () {
    test(
      'keeps the anchored asset at the same distance from the viewport top when assets above it disappear',
      () async {
        final before = _library();
        final beforeSegments = _segments(before);
        // day 15, third row: the offset stays the same while private photos vanish, so a pixel restore would drift
        final offset = _offsetOf(beforeSegments, before, 'd15-8', 4, offsetInRow: 37);
        final anchor = _capture(beforeSegments, before, offset);
        expect(anchor.asset?.id, 'd15-8');

        // private mode locked: every third photo is hidden
        final after = [
          for (int i = 0; i < before.length; i++)
            if (i % 3 != 1) before[i],
        ];
        final afterSegments = _segments(after);
        final restored = await anchor.resolve(segments: afterSegments, columnCount: 4, loadAssets: _loader(after));

        expect(restored, _offsetOf(afterSegments, after, 'd15-8', 4, offsetInRow: 37));
        expect(restored, lessThan(offset), reason: 'hundreds of photos above disappeared');
      },
    );

    test('lands on the stack cover when grouping hides the anchored stack member', () async {
      final before = _library();
      final coverIndex = before.indexWhere((asset) => asset.id == 'd12-3');
      for (final i in [coverIndex, coverIndex + 1, coverIndex + 2]) {
        before[i] = _asset(before[i].id, before[i].createdAt, stackId: 'stack-1');
      }
      final beforeSegments = _segments(before);
      // d12-4 is a stack member and the first photo of its row
      final anchor = _capture(beforeSegments, before, _offsetOf(beforeSegments, before, 'd12-4', 4, offsetInRow: 12));
      expect(anchor.asset?.id, 'd12-4');

      final after = [...before]..removeRange(coverIndex + 1, coverIndex + 3);
      final afterSegments = _segments(after);
      final restored = await anchor.resolve(segments: afterSegments, columnCount: 4, loadAssets: _loader(after));

      expect(restored, _offsetOf(afterSegments, after, 'd12-3', 4, offsetInRow: 12));
    });

    test('keeps the same asset when ungrouping shows the stack members again', () async {
      final all = _library();
      final coverIndex = all.indexWhere((asset) => asset.id == 'd12-4');
      for (final i in [coverIndex, coverIndex + 1, coverIndex + 2]) {
        all[i] = _asset(all[i].id, all[i].createdAt, stackId: 'stack-1');
      }
      final grouped = [...all]..removeRange(coverIndex + 1, coverIndex + 3);
      // plenty of other stacks above the anchor collapse as well
      grouped.removeWhere((asset) => asset.id.startsWith('d2') && asset.id.endsWith('-5'));
      final groupedSegments = _segments(grouped);
      final anchor = _capture(
        groupedSegments,
        grouped,
        _offsetOf(groupedSegments, grouped, 'd12-4', 4, offsetInRow: 50),
      );
      expect(anchor.asset?.id, 'd12-4');

      final allSegments = _segments(all);
      final restored = await anchor.resolve(segments: allSegments, columnCount: 4, loadAssets: _loader(all));

      expect(restored, _offsetOf(allSegments, all, 'd12-4', 4, offsetInRow: 50));
    });

    test('falls back to the photo closest in time when the anchored photo is gone', () async {
      final before = _library();
      final beforeSegments = _segments(before);
      final anchor = _capture(beforeSegments, before, _offsetOf(beforeSegments, before, 'd20-12', 4, offsetInRow: 5));

      final after = before.where((asset) => asset.id != 'd20-12').toList();
      final afterSegments = _segments(after);
      final restored = await anchor.resolve(segments: afterSegments, columnCount: 4, loadAssets: _loader(after));

      // d20-11 and d20-13 are both a minute away, d20-13 takes the vacated index
      expect(restored, _offsetOf(afterSegments, after, 'd20-13', 4, offsetInRow: 5));
    });

    test('uses the nearest day when every photo of the anchored day is gone', () async {
      final before = _library();
      final beforeSegments = _segments(before);
      final anchor = _capture(beforeSegments, before, _offsetOf(beforeSegments, before, 'd18-0', 4, offsetInRow: 20));

      final after = before.where((asset) => !asset.id.startsWith('d18-')).toList();
      final afterSegments = _segments(after);
      final restored = await anchor.resolve(segments: afterSegments, columnCount: 4, loadAssets: _loader(after));

      // the 19th and the 17th are both a day away, the first one in the list wins; its photo closest in time to
      // d18-0 (the 18th at 20:00) is its last one, d19-19 at 19:41 on the 19th
      expect(restored, _offsetOf(afterSegments, after, 'd19-19', 4, offsetInRow: 20));
    });

    test('does not anchor while the start of the timeline is visible', () {
      final assets = _library();
      expect(
        TimelineScrollAnchor.capture(
          segments: _segments(assets),
          scrollOffset: 0,
          columnCount: 4,
          assetAt: (index) => assets[index],
        ),
        isNull,
      );
    });

    test('keeps the relative position in the bucket when the anchored asset was not loaded', () async {
      final before = _library();
      final beforeSegments = _segments(before);
      final anchor = TimelineScrollAnchor.capture(
        segments: beforeSegments,
        scrollOffset: _offsetOf(beforeSegments, before, 'd10-16', 4),
        columnCount: 4,
        assetAt: (_) => null,
      )!;

      final after = before.where((asset) => !(asset.id.startsWith('d10-') && asset.id.endsWith('0'))).toList();
      final afterSegments = _segments(after);
      final restored = await anchor.resolve(segments: afterSegments, columnCount: 4, loadAssets: _loader(after));

      // the 10th shrinks from 20 to 18 photos: index 16 of 20 becomes index 14 of 18, which is d10-16 again
      expect(restored, _offsetOf(afterSegments, after, 'd10-16', 4));
    });

    test('scales the distance into the row when the tile size changes', () async {
      final assets = _library();
      final beforeSegments = _segments(assets);
      final anchor = _capture(beforeSegments, assets, _offsetOf(beforeSegments, assets, 'd8-8', 4, offsetInRow: 51));

      final afterSegments = _segments(assets, columnCount: 3, tileHeight: 150);
      final restored = await anchor.resolve(segments: afterSegments, columnCount: 3, loadAssets: _loader(assets));

      expect(restored, closeTo(_offsetOf(afterSegments, assets, 'd8-8', 3, offsetInRow: 51 * 152 / 102), 0.001));
    });

    test('finds the anchored asset in a bucket too large to search as a whole', () async {
      final start = DateTime(2024, 6);
      final before = [for (int i = 0; i < 10000; i++) _asset('a$i', start.subtract(Duration(minutes: i)))];
      List<Segment> segments(List<BaseAsset> assets) => FixedSegmentBuilder(
        buckets: [Bucket(assetCount: assets.length)],
        tileHeight: _tileHeight,
        columnCount: 4,
        spacing: _spacing,
        groupBy: GroupAssetsBy.none,
      ).generate();

      final beforeSegments = segments(before);
      final anchor = _capture(beforeSegments, before, _offsetOf(beforeSegments, before, 'a8000', 4, offsetInRow: 9));

      // 5000 photos above it disappear, far outside a window around the old index
      final after = [...before]..removeRange(1000, 6000);
      final afterSegments = segments(after);
      final restored = await anchor.resolve(segments: afterSegments, columnCount: 4, loadAssets: _loader(after));

      expect(restored, _offsetOf(afterSegments, after, 'a8000', 4, offsetInRow: 9));
    });
  });

  group('TimelineScrollAnchor.findEquivalentIndex', () {
    test('prefers the asset itself, then its stack, then the closest time', () {
      final time = DateTime(2024);
      final member = _asset('member', time, stackId: 'stack');
      final cover = _asset('cover', time.subtract(const Duration(seconds: 1)), stackId: 'stack');
      final close = _asset('close', time);

      expect(TimelineScrollAnchor.findEquivalentIndex(member, [close, cover, member]), 2);
      expect(TimelineScrollAnchor.findEquivalentIndex(member, [close, cover]), 1);
      expect(TimelineScrollAnchor.findEquivalentIndex(member, [cover.copyWith(stackId: 'other'), close]), 1);
      expect(TimelineScrollAnchor.findEquivalentIndex(member, []), isNull);
    });
  });
}
