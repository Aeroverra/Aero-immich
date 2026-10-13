/// A moment in a video that the current user marked to jump back to. Bookmarks are personal.
class VideoBookmark {
  final String id;
  final String assetId;

  /// Position in the video in milliseconds
  final int time;

  /// Empty when the bookmark has no name
  final String label;

  const VideoBookmark({required this.id, required this.assetId, required this.time, required this.label});

  Duration get position => Duration(milliseconds: time);

  VideoBookmark copyWith({int? time, String? label}) =>
      VideoBookmark(id: id, assetId: assetId, time: time ?? this.time, label: label ?? this.label);

  @override
  bool operator ==(Object other) =>
      other is VideoBookmark &&
      other.id == id &&
      other.assetId == assetId &&
      other.time == time &&
      other.label == label;

  @override
  int get hashCode => Object.hash(id, assetId, time, label);

  @override
  String toString() => 'VideoBookmark(id: $id, assetId: $assetId, time: $time, label: $label)';
}
