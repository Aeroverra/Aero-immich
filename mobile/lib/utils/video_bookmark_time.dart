/// A bookmark position (milliseconds) as the text shown in the time field: m:ss or h:mm:ss, with tenths only when the
/// position is not on a whole second. Same format as the web editor.
String formatBookmarkTime(int ms) {
  final tenths = ((ms < 0 ? 0 : ms) / 100).round();
  final totalSeconds = tenths ~/ 10;
  final hours = totalSeconds ~/ 3600;
  final minutes = (totalSeconds % 3600) ~/ 60;
  final seconds = totalSeconds % 60;
  final fraction = tenths % 10 == 0 ? '' : '.${tenths % 10}';
  final ss = '${seconds.toString().padLeft(2, '0')}$fraction';
  return hours > 0 ? '$hours:${minutes.toString().padLeft(2, '0')}:$ss' : '$minutes:$ss';
}

final _secondsPattern = RegExp(r'^\d+(\.\d+)?$');
final _wholePattern = RegExp(r'^\d+$');

/// Reads a typed position: seconds ("75", "75.5"), m:ss ("1:15") or h:mm:ss ("1:02:03"), a comma works as the decimal
/// point. Returns milliseconds, or null when the text is not a position.
int? parseBookmarkTime(String text) {
  final parts = text.trim().replaceFirst(',', '.').split(':');
  if (parts.length > 3 || parts.any((part) => part.isEmpty)) {
    return null;
  }

  final seconds = parts.last;
  final whole = parts.sublist(0, parts.length - 1);
  if (!_secondsPattern.hasMatch(seconds) || whole.any((part) => !_wholePattern.hasMatch(part))) {
    return null;
  }

  final hours = whole.length == 2 ? int.parse(whole[0]) : 0;
  final minutes = whole.isEmpty ? 0 : int.parse(whole.last);
  final secondsValue = double.parse(seconds);
  // below the largest unit, a field wraps at 60 like a clock
  if ((whole.isNotEmpty && secondsValue >= 60) || (whole.length == 2 && minutes >= 60)) {
    return null;
  }

  return (((hours * 60 + minutes) * 60 + secondsValue) * 1000).round();
}
