import 'package:flutter/foundation.dart';
import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:immich_mobile/domain/models/user.model.dart';

part 'user_metadata.model.freezed.dart';

enum UserMetadataKey {
  // do not change this order!
  onboarding,
  preferences,
  license,
}

/// What the server does with an upload of a file the user permanently deleted before
enum DeletedReimportMode {
  /// store it and move it to the trash right away
  trash,

  /// reject it as a duplicate without storing it
  skip,

  /// store it and add it to the "Previously deleted" album
  album,
}

/// Whether an action on a selection with collapsed stacks includes the assets stacked below the visible ones
enum StackActionMode {
  /// ask on every action
  ask,

  /// act on the visible primary asset of each stack only
  primary,

  /// act on every asset of each stack
  stack,
}

/// When the app locks private mode, or returns to the default view, again
enum LockTrigger {
  /// as soon as the app leaves the foreground, so every app switch relocks
  appPause,

  /// when the screen turns off or the device locks, so app switches keep the unlock
  screenOff,

  /// only when the inactivity timeout passes, the user locks manually or logs out
  timeout,
}

LockTrigger _lockTriggerFromMap(Map<String, Object?> map, String group, LockTrigger fallback) {
  final value = (map[group] as Map<String, Object?>?)?["lockTrigger"] as String?;
  return LockTrigger.values.firstWhere((trigger) => trigger.name == value, orElse: () => fallback);
}

@freezed
abstract class Onboarding with _$Onboarding {
  const Onboarding._();

  const factory Onboarding({required bool isOnboarded}) = _Onboarding;

  factory Onboarding.fromMap(Map<String, Object?> map) {
    return Onboarding(isOnboarded: map["isOnboarded"]! as bool);
  }
}

@freezed
abstract class Preferences with _$Preferences {
  const Preferences._();

  const factory Preferences({
    @Default(false) bool foldersEnabled,
    @Default(true) bool memoriesEnabled,
    @Default(true) bool peopleEnabled,
    @Default(false) bool ratingsEnabled,
    @Default(true) bool sharedLinksEnabled,
    @Default(false) bool tagsEnabled,
    @Default(StackActionMode.ask) StackActionMode stackActionMode,
    @Default(AvatarColor.primary) AvatarColor userAvatarColor,
    @Default(true) bool showSupportBadge,
    @Default(3) int minimumFaces,
    @Default(true) bool groupAutoStacks,
    @Default(LockTrigger.appPause) LockTrigger privateModeLockTrigger,
    @Default(LockTrigger.screenOff) LockTrigger customViewLockTrigger,
    @Default(30) int privateModeTimeoutMinutes,
  }) = _Preferences;

  factory Preferences.fromMap(Map<String, Object?> map) {
    return Preferences(
      foldersEnabled: (map["folders"] as Map<String, Object?>?)?["enabled"] as bool? ?? false,
      memoriesEnabled: (map["memories"] as Map<String, Object?>?)?["enabled"] as bool? ?? true,
      peopleEnabled: (map["people"] as Map<String, Object?>?)?["enabled"] as bool? ?? true,
      ratingsEnabled: (map["ratings"] as Map<String, Object?>?)?["enabled"] as bool? ?? false,
      sharedLinksEnabled: (map["sharedLinks"] as Map<String, Object?>?)?["enabled"] as bool? ?? true,
      tagsEnabled: (map["tags"] as Map<String, Object?>?)?["enabled"] as bool? ?? false,
      stackActionMode: StackActionMode.values.firstWhere(
        (e) => e.name == (map["stackActions"] as Map<String, Object?>?)?["mode"] as String?,
        orElse: () => StackActionMode.ask,
      ),
      userAvatarColor: AvatarColor.values.firstWhere(
        (e) => e.value == (map["avatar"] as Map<String, Object?>?)?["color"] as String?,
        orElse: () => AvatarColor.primary,
      ),
      showSupportBadge: (map["purchase"] as Map<String, Object?>?)?["showSupportBadge"] as bool? ?? true,
      minimumFaces: (map["people"] as Map<String, Object?>?)?["minimumFaces"] as int? ?? 3,
      groupAutoStacks: (map["stacks"] as Map<String, Object?>?)?["groupAuto"] as bool? ?? true,
      privateModeLockTrigger: _lockTriggerFromMap(map, "privateMode", LockTrigger.appPause),
      customViewLockTrigger: _lockTriggerFromMap(map, "customViews", LockTrigger.screenOff),
      privateModeTimeoutMinutes: (map["privateMode"] as Map<String, Object?>?)?["timeoutMinutes"] as int? ?? 30,
    );
  }
}

@freezed
abstract class License with _$License {
  const License._();

  const factory License({required DateTime activatedAt, required String activationKey, required String licenseKey}) =
      _License;

  factory License.fromMap(Map<String, Object?> map) {
    return License(
      activatedAt: DateTime.parse(map["activatedAt"]! as String),
      activationKey: map["activationKey"]! as String,
      licenseKey: map["licenseKey"]! as String,
    );
  }
}

// Model for a user metadata stored in the server
@freezed
abstract class UserMetadata with _$UserMetadata {
  @Assert(
    'onboarding != null || preferences != null || license != null',
    'One of onboarding, preferences and license must be provided',
  )
  const factory UserMetadata({
    required String userId,
    required UserMetadataKey key,
    Onboarding? onboarding,
    Preferences? preferences,
    License? license,
  }) = _UserMetadata;
}
