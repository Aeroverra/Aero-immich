import 'dart:convert';

/// Written by importers such as immich-go for Google Photos takeouts.
const kGooglePhotosMetadataKey = 'google-photos';

const _kGooglePhotosUrlPrefix = 'https://photos.google.com/';

/// App internal bookkeeping, not meant for people.
const _kHiddenMetadataKeys = {'mobile-app', 'deleted-reimport'};

typedef AssetMetadataEntry = ({String key, Map<String, Object?> value});

/// Texts the custom fields rows need, resolved by the caller so the formatting stays free of widgets.
enum AssetMetadataText {
  taken,
  uploaded,
  views,
  origin,
  originMobileUpload,
  originWebUpload,
  originSharedAlbum,
  device,
  deviceAndroidPhone,
  deviceAndroidTablet,
  deviceIosPhone,
  app,
  deviceFolder,
  altitude,
  altitudeValue,
  people,
  peopleRemoved,
  removedNotInPhoto,
  removedOffTopic,
  removedNonHuman,
  addedByOtherUser,
  yes,
  comments,
  commentLiked,
}

typedef AssetMetadataTranslate = String Function(AssetMetadataText text, [Map<String, Object>? args]);

class AssetMetadataRow {
  final String label;
  final String value;

  const AssetMetadataRow(this.label, this.value);

  @override
  bool operator ==(Object other) => other is AssetMetadataRow && other.label == label && other.value == value;

  @override
  int get hashCode => Object.hash(label, value);

  @override
  String toString() => 'AssetMetadataRow($label, $value)';
}

class AssetMetadataGroup {
  final String key;
  final List<AssetMetadataRow> rows;

  const AssetMetadataGroup(this.key, this.rows);

  bool get isGooglePhotos => key == kGooglePhotosMetadataKey;
}

const _originTexts = {
  'mobileUpload': AssetMetadataText.originMobileUpload,
  'webUpload': AssetMetadataText.originWebUpload,
  'sharedAlbum': AssetMetadataText.originSharedAlbum,
};

const _deviceTexts = {
  'ANDROID_PHONE': AssetMetadataText.deviceAndroidPhone,
  'ANDROID_TABLET': AssetMetadataText.deviceAndroidTablet,
  'IOS_PHONE': AssetMetadataText.deviceIosPhone,
};

const _removedReasonTexts = {
  'NOT_IN_PHOTO': AssetMetadataText.removedNotInPhoto,
  'OFF_TOPIC': AssetMetadataText.removedOffTopic,
  'NON_HUMAN': AssetMetadataText.removedNonHuman,
};

bool _isPresent(Object? value) => value != null && value != '' && !(value is List && value.isEmpty);

/// Formats a metadata value for display: primitives as text, lists of primitives joined, anything else as JSON.
String formatAssetMetadataValue(Object? value) {
  if (value is String) {
    return value;
  }
  if (value is num || value is bool) {
    return value.toString();
  }
  if (value is List && value.every((item) => item is! Map && item is! List)) {
    return value.map((item) => item.toString()).join(', ');
  }
  return jsonEncode(value);
}

/// Drops the metadata keys that are not meant to be shown.
List<AssetMetadataEntry> getVisibleAssetMetadata(Iterable<AssetMetadataEntry> entries) =>
    entries.where((entry) => !_kHiddenMetadataKeys.contains(entry.key)).toList();

List<AssetMetadataGroup> getAssetMetadataGroups(
  Iterable<AssetMetadataEntry> entries,
  AssetMetadataTranslate translate,
  String Function(DateTime dateTime) formatDateTime,
) => getVisibleAssetMetadata(entries)
    .map(
      (entry) => AssetMetadataGroup(
        entry.key,
        entry.key == kGooglePhotosMetadataKey
            ? _getGooglePhotosRows(entry.value, translate, formatDateTime)
            : [
                for (final field in entry.value.entries)
                  if (_isPresent(field.value)) AssetMetadataRow(field.key, formatAssetMetadataValue(field.value)),
              ],
      ),
    )
    .where((group) => group.rows.isNotEmpty)
    .toList();

String? getGooglePhotosUrl(Iterable<AssetMetadataEntry> entries) {
  for (final entry in entries) {
    if (entry.key == kGooglePhotosMetadataKey) {
      final url = entry.value['url'];
      return url is String && url.startsWith(_kGooglePhotosUrlPrefix) ? url : null;
    }
  }
  return null;
}

/// Pretty printed JSON of the visible metadata, keyed by metadata key.
String getAssetMetadataJson(Iterable<AssetMetadataEntry> entries) => const JsonEncoder.withIndent(
  '  ',
).convert({for (final entry in getVisibleAssetMetadata(entries)) entry.key: entry.value});

List<AssetMetadataRow> _getGooglePhotosRows(
  Map<String, Object?> value,
  AssetMetadataTranslate t,
  String Function(DateTime dateTime) formatDateTime,
) {
  final rows = <AssetMetadataRow>[];
  void add(String field, AssetMetadataText label, String Function(Object value) format) {
    final fieldValue = value[field];
    if (_isPresent(fieldValue)) {
      rows.add(AssetMetadataRow(t(label), format(fieldValue!)));
    }
  }

  String formatDate(Object date) {
    final parsed = date is String ? DateTime.tryParse(date) : null;
    return parsed == null ? formatAssetMetadataValue(date) : formatDateTime(parsed.toLocal());
  }

  String mapped(Map<String, AssetMetadataText> texts, Object mappedValue) {
    final text = texts[mappedValue];
    return text == null ? formatAssetMetadataValue(mappedValue) : t(text);
  }

  add('takenAt', AssetMetadataText.taken, formatDate);
  add('uploadedAt', AssetMetadataText.uploaded, formatDate);
  add('views', AssetMetadataText.views, formatAssetMetadataValue);
  add('origin', AssetMetadataText.origin, (origin) => mapped(_originTexts, origin));
  add('deviceType', AssetMetadataText.device, (device) => mapped(_deviceTexts, device));
  add('appPackage', AssetMetadataText.app, formatAssetMetadataValue);
  add('deviceFolder', AssetMetadataText.deviceFolder, formatAssetMetadataValue);
  add(
    'altitude',
    AssetMetadataText.altitude,
    (altitude) => altitude is num
        ? t(AssetMetadataText.altitudeValue, {'altitude': _roundToTenth(altitude)})
        : formatAssetMetadataValue(altitude),
  );
  add('people', AssetMetadataText.people, formatAssetMetadataValue);
  add(
    'peopleRemovedReasons',
    AssetMetadataText.peopleRemoved,
    (reasons) => reasons is List
        ? reasons.map((reason) => mapped(_removedReasonTexts, reason ?? '')).join(', ')
        : formatAssetMetadataValue(reasons),
  );
  if (value['addedByOtherUser'] == true) {
    rows.add(AssetMetadataRow(t(AssetMetadataText.addedByOtherUser), t(AssetMetadataText.yes)));
  }
  add('comments', AssetMetadataText.comments, (comments) {
    if (comments is! List) {
      return formatAssetMetadataValue(comments);
    }
    return comments
        .map((comment) {
          if (comment is! Map) {
            return formatAssetMetadataValue(comment);
          }
          final author = comment['author'] is String ? comment['author'] as String : '';
          final text = comment['text'];
          if (text is String && text.isNotEmpty) {
            return author.isEmpty ? text : '$author: $text';
          }
          return comment['liked'] == true ? t(AssetMetadataText.commentLiked, {'author': author}) : author;
        })
        .where((line) => line.isNotEmpty)
        .join('\n');
  });

  return rows;
}

/// Rounds to one decimal, dropping a trailing ".0".
String _roundToTenth(num value) {
  final rounded = (value * 10).round() / 10;
  return rounded == rounded.truncateToDouble() ? rounded.toInt().toString() : rounded.toString();
}
