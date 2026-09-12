/// Describes how private assets are filtered in local queries.
///
/// The sync stream always delivers private assets, so every query that lists
/// assets applies this filter: private assets are hidden unless the session's
/// private mode is [enabled] and the asset belongs to [userId]. Partner private
/// assets are never shown.
class PrivateModeFilter {
  final bool enabled;
  final String? userId;

  const PrivateModeFilter({required this.enabled, this.userId});

  static const off = PrivateModeFilter(enabled: false);

  bool get showsOwnPrivate => enabled && userId != null;

  @override
  bool operator ==(Object other) => other is PrivateModeFilter && other.enabled == enabled && other.userId == userId;

  @override
  int get hashCode => enabled.hashCode ^ userId.hashCode;

  @override
  String toString() => 'PrivateModeFilter(enabled: $enabled, userId: $userId)';
}

/// Server-side private mode state of the current session
class PrivateModeStatus {
  final bool enabled;
  final DateTime? expiresAt;

  const PrivateModeStatus({required this.enabled, this.expiresAt});
}
