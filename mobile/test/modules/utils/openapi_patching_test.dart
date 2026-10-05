import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/utils/openapi_patching.dart';
import 'package:openapi/api.dart';

void main() {
  group('Test OpenApi Patching', () {
    test('upgradeDto', () {
      dynamic value;
      String targetType;

      targetType = 'UserPreferencesResponseDto';
      value = jsonDecode("""
{
  "download": {
    "archiveSize": 4294967296,
    "includeEmbeddedVideos": false
  }
}
""");

      upgradeDto(value, targetType);
      expect(value['tags'], TagsResponse(enabled: false, sidebarWeb: false).toJson());
      expect(value['download']['includeEmbeddedVideos'], false);
    });

    test('reads preferences and stacks from servers without the stack source', () {
      // preferences as sent by a server that predates the stacks block
      final preferences = UserPreferencesResponseDto.fromJson(
        jsonDecode("""
{
  "albums": {"defaultAssetOrder": "desc"},
  "folders": {"enabled": false, "sidebarWeb": false},
  "memories": {"enabled": true, "duration": 5, "sidebarWeb": false},
  "people": {"enabled": true, "sidebarWeb": false, "minimumFaces": 3},
  "sharedLinks": {"enabled": true, "sidebarWeb": false},
  "ratings": {"enabled": false},
  "tags": {"enabled": false, "sidebarWeb": false},
  "emailNotifications": {"enabled": true, "albumInvite": true, "albumUpdate": true},
  "download": {"archiveSize": 4294967296, "includeEmbeddedVideos": false},
  "purchase": {"showSupportBadge": true, "hideBuyButtonUntil": "2022-02-12T00:00:00.000Z"},
  "cast": {"gCastEnabled": false},
  "recentlyAdded": {"sidebarWeb": false},
  "privateMode": {"timeoutMinutes": 30, "sidebarWeb": true, "includeInMemories": false},
  "deletedReimport": {"mode": "trash", "albumId": null}
}
"""),
      );
      expect(preferences, isNotNull);
      expect(preferences!.stacks.groupAuto, isTrue);
      expect(preferences.autoStack.enabled, isFalse);
      expect(preferences.stackActions.mode, StackActionMode.ask);

      final stack = StackResponseDto.fromJson(
        jsonDecode('{"id": "stack-1", "primaryAssetId": "asset-1", "assets": []}'),
      );
      expect(stack, isNotNull);
      expect(stack!.source_, StackSource.manual);

      final assetStack = AssetStackResponseDto.fromJson(
        jsonDecode('{"id": "stack-1", "primaryAssetId": "asset-1", "assetCount": 2}'),
      );
      expect(assetStack, isNotNull);
      expect(assetStack!.source_, StackSource.manual);
    });

    test('reads queues from servers without face attributes, automatic stacks and video frame analysis', () {
      final queue = {
        'jobCounts': {'active': 1, 'completed': 0, 'delayed': 0, 'failed': 0, 'paused': 0, 'waiting': 2},
        'queueStatus': {'isActive': true, 'isPaused': false},
      };
      const names = [
        'backgroundTask',
        'backupDatabase',
        'duplicateDetection',
        'editor',
        'faceDetection',
        'facialRecognition',
        'integrityCheck',
        'library',
        'metadataExtraction',
        'migration',
        'notifications',
        'ocr',
        'search',
        'sidecar',
        'smartSearch',
        'storageTemplateMigration',
        'thumbnailGeneration',
        'videoConversion',
        'workflow',
      ];

      // decoded like a response body, so the maps can take the patched queues
      final queues = QueuesResponseLegacyDto.fromJson(jsonDecode(jsonEncode({for (final name in names) name: queue})));

      expect(queues, isNotNull);
      expect(queues!.faceAttributes.jobCounts.waiting, 0);
      expect(queues.autoStack.queueStatus.isActive, isFalse);
      expect(queues.videoFrameAnalysis.jobCounts.waiting, 0);
      expect(queues.smartSearch.jobCounts.waiting, 2);
    });

    test('addDefault', () {
      final dynamic value = jsonDecode("""
{
  "download": {
    "archiveSize": 4294967296,
    "includeEmbeddedVideos": false
  }
}
""");
      String keys = 'download.unknownKey';
      dynamic defaultValue = 69420;

      addDefault(value, keys, defaultValue);
      expect(value['download']['unknownKey'], 69420);

      keys = 'alpha.beta';
      defaultValue = 'gamma';
      addDefault(value, keys, defaultValue);
      expect(value['alpha']['beta'], 'gamma');
    });

    test('addDefault with null', () {
      final dynamic value = jsonDecode("""
{
  "download": {
    "archiveSize": 4294967296,
    "includeEmbeddedVideos": false
  }
}
""");
      expect(value['download']['unknownKey'], isNull);
    });
  });
}
