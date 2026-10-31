import 'package:immich_mobile/domain/models/custom_view.model.dart';

/// Describes how private assets are filtered in local queries.
///
/// The sync stream always delivers private assets, so every query that lists
/// assets applies this filter: private assets are hidden unless the session's
/// private mode is [enabled] and the asset belongs to [userId]. Partner private
/// assets are never shown.
///
/// The sync stream also delivers the assets the applied custom [view] hides, so the
/// same queries keep only the assets that pass it. Without a view every asset passes.
class PrivateModeFilter {
  final bool enabled;
  final String? userId;
  final ViewFilter? view;

  const PrivateModeFilter({required this.enabled, this.userId, this.view});

  static const off = PrivateModeFilter(enabled: false);

  /// Shows private albums and their assets regardless of the session state. Only for background
  /// work that must see the full album list (the linked album backup), never for anything rendered.
  static const all = PrivateModeFilter(enabled: true);

  bool get showsOwnPrivate => enabled && userId != null;

  /// The view to evaluate, null when there is none or it lets every asset through
  ViewFilter? get restrictingView => view == null || view!.isUnrestricted ? null : view;

  /// Whether local only (not yet uploaded) assets are listed next to the remote ones. They carry no tags yet and are
  /// never private, so every view shows them (they are on the device anyway) except a view of private assets only,
  /// whose rule they can never meet
  bool get showsLocalOnly => restrictingView?.privateAssets != ViewPrivateAssets.only;

  @override
  bool operator ==(Object other) =>
      other is PrivateModeFilter && other.enabled == enabled && other.userId == userId && other.view == view;

  @override
  int get hashCode => Object.hash(enabled, userId, view);

  @override
  String toString() => 'PrivateModeFilter(enabled: $enabled, userId: $userId, view: $view)';
}

/// Server-side private mode state of the current session
class PrivateModeStatus {
  final bool enabled;
  final DateTime? expiresAt;

  const PrivateModeStatus({required this.enabled, this.expiresAt});
}
