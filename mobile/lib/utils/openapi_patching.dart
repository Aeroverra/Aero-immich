import 'package:flutter/foundation.dart';
import 'package:openapi/api.dart';

abstract interface class _Dynamic {
  Object? resolve();
}

class _CurrentTimestamp implements _Dynamic {
  const _CurrentTimestamp();

  @override
  Object? resolve() => DateTime.now().toIso8601String();
}

const _now = _CurrentTimestamp();

/// A queue that does not exist on the server: nothing queued, not running. Plain maps, because toJson keeps nested
/// DTOs as objects that fromJson cannot read back.
final _emptyQueue = <String, Object?>{
  'jobCounts': {'active': 0, 'completed': 0, 'delayed': 0, 'failed': 0, 'paused': 0, 'waiting': 0},
  'queueStatus': {'isActive': false, 'isPaused': false},
};

@visibleForTesting
final Map<String, Map<String, Object?>> openApiPatches = {
  'UserPreferencesResponseDto': {
    'download.includeEmbeddedVideos': false,
    'folders': FoldersResponse(enabled: false, sidebarWeb: false).toJson(),
    'memories': MemoriesResponse(enabled: true, duration: 5, sidebarWeb: false).toJson(),
    'ratings': RatingsResponse(enabled: false).toJson(),
    'people': PeopleResponse(enabled: true, sidebarWeb: false).toJson(),
    'tags': TagsResponse(enabled: false, sidebarWeb: false).toJson(),
    'sharedLinks': SharedLinksResponse(enabled: true, sidebarWeb: false).toJson(),
    'cast': CastResponse(gCastEnabled: false).toJson(),
    'albums': {'defaultAssetOrder': 'desc'},
    'recentlyAdded': RecentlyAddedResponse(sidebarWeb: false).toJson(),
    'stacks': StacksResponse(groupAuto: true).toJson(),
    'autoStack': AutoStackResponse(enabled: false).toJson(),
    'stackActions': StackActionsResponse(mode: StackActionMode.ask).toJson(),
  },
  'ServerConfigDto': {
    'mapLightStyleUrl': 'https://tiles.immich.cloud/v1/style/light.json',
    'mapDarkStyleUrl': 'https://tiles.immich.cloud/v1/style/dark.json',
    'minFaces': 3,
  },
  'UserResponseDto': {'profileChangedAt': _now},
  'AssetResponseDto': {'visibility': 'timeline', 'createdAt': _now, 'isEdited': false},
  'UserAdminResponseDto': {'profileChangedAt': _now, 'clusterGroupId': ''},
  'LoginResponseDto': {'isOnboarded': false},
  'SyncUserV1': {'profileChangedAt': _now, 'hasProfileImage': false},
  'SyncAssetV1': {'isEdited': false},
  'ServerFeaturesDto': {
    'ocr': false,
    'faceAttributes': false,
    'realtimeTranscoding': false,
    'videoFrameAnalysis': false,
    'customViews': false,
  },
  'TagResponseDto': {'isHidden': false},
  'SearchAssetResponseDto': {'nextCursor': null},
  'StackResponseDto': {'source': 'manual'},
  'AssetStackResponseDto': {'source': 'manual'},
  'MemoriesResponse': {'duration': 5, 'sidebarWeb': false},
  'AdminConfigJobDto': {'faceAttributes': AdminConfigJobSettingsDto(concurrency: 2).toJson()},
  'AdminConfigMachineLearningDto': {
    'faceAttributes': AdminConfigFaceAttributesDto(enabled: false, modelName: 'face_landmarker').toJson(),
    'autoStack': AdminConfigAutoStackDto(
      enabled: false,
      maxAssets: 100,
      maxDistance: 0.06,
      maxFaceShift: 0.1,
      maxFaceSizeChange: 0.25,
      maxGapSeconds: 5,
      maxSmileChange: 0.4,
      maxSpanSeconds: 30,
      maxYawChange: 15,
    ).toJson(),
  },
  'AdminConfigNightlyTasksDto': {'autoStack': false},
  'UserConfigMachineLearningDto': {
    'faceAttributes': UserConfigFaceAttributesDto(enabled: false).toJson(),
    'autoStack': UserConfigAutoStackDto(enabled: false).toJson(),
  },
  'QueuesResponseLegacyDto': {'faceAttributes': _emptyQueue, 'autoStack': _emptyQueue},
  'WorkflowResponseDto': {'logging': false},
};

void upgradeDto(dynamic value, String targetType) {
  if (value is! Map) {
    return;
  }
  final fields = openApiPatches[targetType];
  if (fields == null) {
    return;
  }
  fields.forEach((key, defaultValue) {
    addDefault(value, key, defaultValue is _Dynamic ? defaultValue.resolve() : defaultValue);
  });
}

void addDefault(dynamic value, String keys, dynamic defaultValue) {
  // Loop through the keys and assign the default value if the key is not present
  final List<String> keyList = keys.split('.');
  dynamic current = value;

  for (int i = 0; i < keyList.length - 1; i++) {
    if (current[keyList[i]] == null) {
      current[keyList[i]] = {};
    }
    current = current[keyList[i]];
  }

  if (current[keyList.last] == null) {
    current[keyList.last] = defaultValue;
  }
}
