import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/domain/services/asset.service.dart';

/// What could show an asset opened by link that the session does not show right now
class HiddenAssetOptions {
  /// the asset shows as things are, nothing to ask
  final bool visible;

  /// the switchable views that show the asset
  final List<CustomView> views;

  /// the user has no default view, so switching back to the default (all photos) shows the asset too
  final bool allPhotos;

  const HiddenAssetOptions({this.visible = false, this.views = const [], this.allPhotos = false});

  static const none = HiddenAssetOptions();

  bool get hasViews => views.isNotEmpty || allPhotos;
}

/// The state of the library the options are evaluated against
class HiddenAssetContext {
  final PrivateModeFilter filter;
  final CustomView? appliedView;

  /// the views the switcher lists right now (private access ones only while private mode is on)
  final List<CustomView> switchableViews;

  /// every synced view, to tell whether a default view exists
  final List<CustomView> allViews;
  final List<TagEntry> tags;

  const HiddenAssetContext({
    required this.filter,
    required this.appliedView,
    required this.switchableViews,
    required this.allViews,
    required this.tags,
  });
}

/// Finds out how an asset opened by link can be shown: it may be private while private mode is off, or the applied
/// view may hide it. Evaluates the synced data with the same rules the library uses, so it also works offline.
class HiddenAssetService {
  final AssetService _assetService;

  const HiddenAssetService(this._assetService);

  Future<HiddenAssetOptions> getOptions(String assetId, HiddenAssetContext context) async {
    if (await _assetService.getRemoteAsset(assetId) == null) {
      return HiddenAssetOptions.none;
    }

    final filter = context.filter;
    if (await _assetService.isRemoteAssetVisible(assetId, filter)) {
      return const HiddenAssetOptions(visible: true);
    }

    // only the view is left out, so an asset private mode hides stays hidden until the mode is on
    final withoutView = PrivateModeFilter(enabled: filter.enabled, userId: filter.userId);
    if (!await _assetService.isRemoteAssetVisible(assetId, withoutView)) {
      return HiddenAssetOptions.none;
    }

    final applied = context.appliedView;
    final views = <CustomView>[];
    for (final view in context.switchableViews) {
      if (view.id == applied?.id) {
        continue;
      }
      if (await _assetService.isRemoteAssetInView(assetId, ViewFilter.fromView(view, context.tags))) {
        views.add(view);
      }
    }

    final hasDefaultView = context.allViews.any((view) => view.isDefault);
    final allPhotos = applied != null && !applied.isDefault && !hasDefaultView;
    return HiddenAssetOptions(views: views, allPhotos: allPhotos);
  }
}
