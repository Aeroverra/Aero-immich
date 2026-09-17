import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/utils/asset_metadata.utils.dart';

String _translate(AssetMetadataText text, [Map<String, Object>? args]) =>
    args == null ? text.name : '${text.name}(${args.values.join(', ')})';

String _formatDateTime(DateTime dateTime) => 'date(${dateTime.toUtc().toIso8601String()})';

List<AssetMetadataGroup> _groups(List<AssetMetadataEntry> entries) =>
    getAssetMetadataGroups(entries, _translate, _formatDateTime);

void main() {
  group('getAssetMetadataGroups', () {
    test('formats google photos fields in order and skips missing ones', () {
      final groups = _groups([
        (
          key: 'google-photos',
          value: {
            'url': 'https://photos.google.com/photo/abc',
            'views': 12,
            'people': ['Thomas', 'Nicholas Halka'],
            'origin': 'mobileUpload',
            'takenAt': '2020-01-02T03:04:05.000Z',
            'altitude': -15.89,
            'uploadedAt': '2020-01-03T00:00:00.000Z',
            'appPackage': 'com.google.android.GoogleCamera',
            'deviceType': 'ANDROID_PHONE',
            'deviceFolder': 'Camera',
            'addedByOtherUser': true,
            'peopleRemovedReasons': ['NOT_IN_PHOTO', 'OFF_TOPIC', 'NON_HUMAN', 'SOMETHING_ELSE'],
            'comments': [
              {'at': '2020-01-04T00:00:00.000Z', 'liked': true, 'author': 'Karen Rose'},
              {'author': 'Bob', 'text': 'Nice'},
              {'liked': false},
            ],
          },
        ),
      ]);

      expect(groups, hasLength(1));
      expect(groups.single.isGooglePhotos, isTrue);
      expect(groups.single.rows, const [
        AssetMetadataRow('taken', 'date(2020-01-02T03:04:05.000Z)'),
        AssetMetadataRow('uploaded', 'date(2020-01-03T00:00:00.000Z)'),
        AssetMetadataRow('views', '12'),
        AssetMetadataRow('origin', 'originMobileUpload'),
        AssetMetadataRow('device', 'deviceAndroidPhone'),
        AssetMetadataRow('app', 'com.google.android.GoogleCamera'),
        AssetMetadataRow('deviceFolder', 'Camera'),
        AssetMetadataRow('altitude', 'altitudeValue(-15.9)'),
        AssetMetadataRow('people', 'Thomas, Nicholas Halka'),
        AssetMetadataRow('peopleRemoved', 'removedNotInPhoto, removedOffTopic, removedNonHuman, SOMETHING_ELSE'),
        AssetMetadataRow('addedByOtherUser', 'yes'),
        AssetMetadataRow('comments', 'commentLiked(Karen Rose)\nBob: Nice'),
      ]);
    });

    test('shows unknown mapped values raw and handles unparsable dates and whole altitudes', () {
      final groups = _groups([
        (
          key: 'google-photos',
          value: {
            'takenAt': 'not a date',
            'origin': 'somewhereElse',
            'deviceType': 'CHROMEBOOK',
            'altitude': 100.04,
            'addedByOtherUser': false,
          },
        ),
      ]);

      expect(groups.single.rows, const [
        AssetMetadataRow('taken', 'not a date'),
        AssetMetadataRow('origin', 'somewhereElse'),
        AssetMetadataRow('device', 'CHROMEBOOK'),
        AssetMetadataRow('altitude', 'altitudeValue(100)'),
      ]);
    });

    test('lists other keys generically and hides internal keys', () {
      final groups = _groups([
        (key: 'mobile-app', value: {'foo': 'bar'}),
        (key: 'deleted-reimport', value: {'foo': 'bar'}),
        (
          key: 'custom',
          value: {
            'name': 'value',
            'count': 3,
            'flag': false,
            'tags': ['a', 'b'],
            'nested': {'x': 1},
            'empty': '',
            'none': null,
          },
        ),
      ]);

      expect(groups, hasLength(1));
      expect(groups.single.key, 'custom');
      expect(groups.single.isGooglePhotos, isFalse);
      expect(groups.single.rows, const [
        AssetMetadataRow('name', 'value'),
        AssetMetadataRow('count', '3'),
        AssetMetadataRow('flag', 'false'),
        AssetMetadataRow('tags', 'a, b'),
        AssetMetadataRow('nested', '{"x":1}'),
      ]);
    });

    test('returns nothing when only internal or empty keys exist', () {
      expect(
        _groups([
          (key: 'mobile-app', value: {'foo': 'bar'}),
          (key: 'custom', value: {}),
        ]),
        isEmpty,
      );
    });
  });

  group('getGooglePhotosUrl', () {
    test('returns google photos urls only', () {
      expect(
        getGooglePhotosUrl([
          (key: 'google-photos', value: {'url': 'https://photos.google.com/photo/abc'}),
        ]),
        'https://photos.google.com/photo/abc',
      );
      expect(
        getGooglePhotosUrl([
          (key: 'google-photos', value: {'url': 'https://example.com/photo/abc'}),
        ]),
        isNull,
      );
      expect(
        getGooglePhotosUrl([
          (key: 'custom', value: {'url': 'https://photos.google.com/photo/abc'}),
        ]),
        isNull,
      );
    });
  });

  group('getAssetMetadataJson', () {
    test('pretty prints the visible keys', () {
      expect(
        getAssetMetadataJson([
          (key: 'mobile-app', value: {'foo': 'bar'}),
          (key: 'google-photos', value: {'views': 1}),
        ]),
        '{\n  "google-photos": {\n    "views": 1\n  }\n}',
      );
    });
  });
}
