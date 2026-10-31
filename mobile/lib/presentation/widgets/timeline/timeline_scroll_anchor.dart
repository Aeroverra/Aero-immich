import 'dart:math' as math;

import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/timeline.model.dart';
import 'package:immich_mobile/presentation/widgets/timeline/segment.model.dart';

/// Loads [count] timeline assets starting at [index]
typedef TimelineAnchorAssetLoader = Future<List<BaseAsset>> Function(int index, int count);

/// Returns the timeline asset at [index] when it is already loaded
typedef TimelineAnchorAssetLookup = BaseAsset? Function(int index);

/// What is at the top of the timeline viewport, captured before the segments are rebuilt (private mode toggled,
/// stack grouping changed, partners changed, width or tiles per row changed) and resolved against the new segments,
/// so the user keeps looking at the same photos instead of the same pixel offset or asset index
class TimelineScrollAnchor {
  /// Buckets larger than this are searched in a window around the expected position instead of as a whole
  static const int maxSearchCount = 2000;

  /// The first asset of the top visible row, null when it was not loaded
  final BaseAsset? asset;

  /// The bucket that asset belonged to
  final Bucket bucket;

  /// Index of the asset in the whole timeline, used for buckets without a date
  final int assetIndex;

  /// Index of the asset within its bucket
  final int indexInBucket;

  /// Number of assets in that bucket
  final int bucketAssetCount;

  /// How far the viewport top is below the top of the asset row, negative while the bucket header is still visible
  final double offsetInRow;

  /// Height of one row including spacing when captured, to scale [offsetInRow] when the tile size changes
  final double rowExtent;

  /// The segments the anchor was captured from
  final List<Segment> segments;

  const TimelineScrollAnchor._({
    required this.asset,
    required this.bucket,
    required this.assetIndex,
    required this.indexInBucket,
    required this.bucketAssetCount,
    required this.offsetInRow,
    required this.rowExtent,
    required this.segments,
  });

  /// Captures the anchor at [scrollOffset], measured from the start of the segments (preceding slivers excluded).
  /// Returns null when the start of the timeline is visible, nothing needs to be restored then
  static TimelineScrollAnchor? capture({
    required List<Segment> segments,
    required double scrollOffset,
    required int columnCount,
    required TimelineAnchorAssetLookup assetAt,
  }) {
    if (segments.isEmpty || columnCount <= 0 || !scrollOffset.isFinite || scrollOffset <= 0) {
      return null;
    }

    final segment = segments.findByOffset(scrollOffset)!;
    final assetCount = segment.bucket.assetCount;
    if (assetCount <= 0) {
      return null;
    }

    final rowIndex = segment.getMinChildIndexForScrollOffset(scrollOffset);
    final int indexInBucket;
    final double rowTop;
    if (rowIndex <= segment.firstIndex) {
      // the header is at the viewport top, anchor to the first asset of the bucket
      indexInBucket = 0;
      rowTop = segment.gridOffset;
    } else {
      indexInBucket = math.min((rowIndex - segment.gridIndex) * columnCount, assetCount - 1);
      rowTop = segment.indexToLayoutOffset(segment.gridIndex + indexInBucket ~/ columnCount);
    }

    final assetIndex = segment.firstAssetIndex + indexInBucket;
    return TimelineScrollAnchor._(
      asset: assetAt(assetIndex),
      bucket: segment.bucket,
      assetIndex: assetIndex,
      indexInBucket: indexInBucket,
      bucketAssetCount: assetCount,
      offsetInRow: scrollOffset - rowTop,
      rowExtent: _rowExtent(segment),
      segments: segments,
    );
  }

  /// Computes the scroll offset (from the start of [segments]) that shows the anchored place again:
  /// 1. the same asset at the same distance from the viewport top
  /// 2. when it is hidden now, the asset standing for its stack (the cover when stacks got grouped)
  /// 3. otherwise the asset closest in time within the same bucket, or the nearest bucket by date
  /// 4. without dates, the same relative position within the bucket
  Future<double?> resolve({
    required List<Segment> segments,
    required int columnCount,
    required TimelineAnchorAssetLoader loadAssets,
  }) async {
    if (segments.isEmpty || columnCount <= 0) {
      return null;
    }

    final segment = _findSegment(segments);
    final assetCount = segment.bucket.assetCount;
    if (assetCount <= 0) {
      return segment.startOffset;
    }

    // same relative position in the bucket, for when nothing better is known
    int indexInSegment = math.min((indexInBucket * assetCount / math.max(1, bucketAssetCount)).floor(), assetCount - 1);

    final asset = this.asset;
    if (asset != null) {
      try {
        // where the asset would be if only it had vanished: whatever slid into its place wins ties
        int expectedIndex = math.min(indexInBucket, assetCount - 1);
        final int windowStart;
        final int windowCount;
        if (assetCount <= maxSearchCount) {
          windowStart = 0;
          windowCount = assetCount;
        } else {
          expectedIndex = await _findIndexByDate(segment, asset.createdAt, loadAssets) ?? indexInSegment;
          indexInSegment = expectedIndex;
          windowStart = (expectedIndex - maxSearchCount ~/ 2).clamp(0, assetCount - maxSearchCount);
          windowCount = maxSearchCount;
        }

        final assets = await loadAssets(segment.firstAssetIndex + windowStart, windowCount);
        final found = findEquivalentIndex(asset, assets, expectedIndex: expectedIndex - windowStart);
        if (found != null) {
          indexInSegment = math.min(windowStart + found, assetCount - 1);
        }
      } catch (_) {
        // the relative position below is still a sensible place
      }
    }

    final rowIndex = segment.gridIndex + indexInSegment ~/ columnCount;
    final rowTop = segment.indexToLayoutOffset(rowIndex);
    final newRowExtent = _rowExtent(segment);
    final double offset;
    if (offsetInRow >= 0 && rowExtent > 0 && newRowExtent > 0) {
      offset = rowTop + math.min(offsetInRow * newRowExtent / rowExtent, newRowExtent);
    } else {
      offset = rowTop + offsetInRow;
    }
    return math.max(0, offset);
  }

  /// Index in [assets] of [anchor] itself, else of the asset standing for its stack, else of the asset closest in time
  /// (ties go to the one closest to [expectedIndex]). Null when [assets] is empty
  static int? findEquivalentIndex(BaseAsset anchor, List<BaseAsset> assets, {int expectedIndex = 0}) {
    if (assets.isEmpty) {
      return null;
    }

    for (int i = 0; i < assets.length; i++) {
      if (assets[i].refersToSameAsset(anchor)) {
        return i;
      }
    }

    final stackId = anchor is RemoteAsset ? anchor.stackId : null;
    if (stackId != null) {
      for (int i = 0; i < assets.length; i++) {
        final candidate = assets[i];
        if (candidate is RemoteAsset && candidate.stackId == stackId) {
          return i;
        }
      }
    }

    int best = 0;
    int bestTime = -1;
    int bestDistance = -1;
    for (int i = 0; i < assets.length; i++) {
      final time = assets[i].createdAt.difference(anchor.createdAt).inMilliseconds.abs();
      final distance = (i - expectedIndex).abs();
      if (bestTime < 0 || time < bestTime || (time == bestTime && distance < bestDistance)) {
        best = i;
        bestTime = time;
        bestDistance = distance;
      }
    }
    return best;
  }

  /// Binary search for the first asset of a large bucket that is at or past [date] in the bucket's sort direction,
  /// so a bucket without dates of its own (or a very large month) still lands near the anchored time
  static Future<int?> _findIndexByDate(Segment segment, DateTime date, TimelineAnchorAssetLoader loadAssets) async {
    final count = segment.bucket.assetCount;
    Future<DateTime?> dateAt(int index) async {
      final assets = await loadAssets(segment.firstAssetIndex + index, 1);
      return assets.isEmpty ? null : assets.first.createdAt;
    }

    final first = await dateAt(0);
    final last = await dateAt(count - 1);
    if (first == null || last == null) {
      return null;
    }
    final descending = !first.isBefore(last);

    int low = 0;
    int high = count - 1;
    while (low < high) {
      final middle = (low + high) ~/ 2;
      final middleDate = await dateAt(middle);
      if (middleDate == null) {
        return null;
      }
      final isPast = descending ? !middleDate.isAfter(date) : !middleDate.isBefore(date);
      if (isPast) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    return low;
  }

  Segment _findSegment(List<Segment> segments) {
    final bucket = this.bucket;
    if (bucket is TimeBucket) {
      Segment? nearest;
      int nearestDistance = -1;
      for (final segment in segments) {
        final candidate = segment.bucket;
        if (candidate is! TimeBucket) {
          continue;
        }
        if (candidate.date == bucket.date) {
          return segment;
        }
        final distance = candidate.date.difference(bucket.date).inMilliseconds.abs();
        if (nearestDistance < 0 || distance < nearestDistance) {
          nearest = segment;
          nearestDistance = distance;
        }
      }
      if (nearest != null) {
        return nearest;
      }
    }

    for (final segment in segments) {
      if (assetIndex < segment.firstAssetIndex + segment.bucket.assetCount) {
        return segment;
      }
    }
    return segments.last;
  }

  static double _rowExtent(Segment segment) =>
      segment.indexToLayoutOffset(segment.gridIndex + 1) - segment.indexToLayoutOffset(segment.gridIndex);
}
