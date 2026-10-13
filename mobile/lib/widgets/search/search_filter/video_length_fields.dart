import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';

final _lengthPattern = RegExp(r'^\d+(:\d{1,2}){0,2}$');

/// A video length typed as seconds, m:ss or h:mm:ss, in milliseconds: (null, false) when empty, (null, true) when
/// the text is not a length
({int? milliseconds, bool invalid}) parseVideoLength(String text) {
  final value = text.trim();
  if (value.isEmpty) {
    return (milliseconds: null, invalid: false);
  }
  if (!_lengthPattern.hasMatch(value)) {
    return (milliseconds: null, invalid: true);
  }
  final seconds = value.split(':').fold(0, (total, part) => total * 60 + int.parse(part));
  return (milliseconds: seconds * 1000, invalid: false);
}

/// A video length in milliseconds as m:ss, or h:mm:ss from an hour on
String formatVideoLength(int milliseconds) {
  final total = (milliseconds / 1000).round();
  final hours = total ~/ 3600;
  final minutes = (total % 3600) ~/ 60;
  final seconds = (total % 60).toString().padLeft(2, '0');
  return hours > 0 ? '$hours:${minutes.toString().padLeft(2, '0')}:$seconds' : '$minutes:$seconds';
}

/// "0:30 to 5:00", "0:30 or longer" or "up to 5:00"; null without bounds
String? videoLengthLabel(BuildContext context, int? minDuration, int? maxDuration) {
  if (minDuration != null && maxDuration != null) {
    return context.t.search_video_length_range(
      shortest: formatVideoLength(minDuration),
      longest: formatVideoLength(maxDuration),
    );
  }
  if (minDuration != null) {
    return context.t.search_video_length_at_least(duration: formatVideoLength(minDuration));
  }
  if (maxDuration != null) {
    return context.t.search_video_length_at_most(duration: formatVideoLength(maxDuration));
  }
  return null;
}

/// The shortest and longest video length a search keeps; a length that does not parse leaves its bound out
class VideoLengthFields extends HookWidget {
  final int? initialMin;
  final int? initialMax;
  final void Function(int? minDuration, int? maxDuration) onChanged;

  const VideoLengthFields({super.key, this.initialMin, this.initialMax, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final minController = useTextEditingController(text: initialMin == null ? '' : formatVideoLength(initialMin!));
    final maxController = useTextEditingController(text: initialMax == null ? '' : formatVideoLength(initialMax!));
    final min = useValueListenable(minController);
    final max = useValueListenable(maxController);
    final minLength = parseVideoLength(min.text);
    final maxLength = parseVideoLength(max.text);

    useEffect(() {
      onChanged(minLength.milliseconds, maxLength.milliseconds);
      return null;
    }, [minLength.milliseconds, maxLength.milliseconds]);

    InputDecoration decoration(String label, String hint, bool invalid) => InputDecoration(
      labelText: label,
      hintText: hint,
      border: const OutlineInputBorder(),
      errorText: invalid ? context.t.search_video_length_invalid : null,
      errorMaxLines: 2,
    );

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        spacing: 8,
        children: [
          Text(context.t.search_video_length, style: context.textTheme.titleSmall),
          Text(context.t.search_video_length_description, style: context.textTheme.bodySmall),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            spacing: 12,
            children: [
              Expanded(
                child: TextField(
                  key: const Key('video-length-min'),
                  controller: minController,
                  keyboardType: TextInputType.datetime,
                  decoration: decoration(context.t.search_at_least, '0:30', minLength.invalid),
                ),
              ),
              Expanded(
                child: TextField(
                  key: const Key('video-length-max'),
                  controller: maxController,
                  keyboardType: TextInputType.datetime,
                  decoration: decoration(context.t.search_at_most, '5:00', maxLength.invalid),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
