import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/widgets/search/search_filter/people_picker.dart';

/// Opens the sheet that picks the people to tag on [assetCount] selected assets. Resolves to the picked people, or to
/// null when the sheet is closed without tagging.
Future<Set<Person>?> showTagPeopleSheet(BuildContext context, int assetCount) {
  return showModalBottomSheet<Set<Person>>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => FractionallySizedBox(heightFactor: 0.8, child: TagPeopleSheet(assetCount: assetCount)),
  );
}

class TagPeopleSheet extends HookWidget {
  final int assetCount;

  const TagPeopleSheet({super.key, required this.assetCount});

  @override
  Widget build(BuildContext context) {
    final selected = useState<Set<Person>>(const {});

    return SafeArea(
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(context.t.tag_people_in_videos, style: context.textTheme.headlineSmall),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              context.t.tag_people_in_videos_description(count: assetCount),
              style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceSecondary),
              textAlign: TextAlign.center,
            ),
          ),
          Expanded(child: PeoplePicker(onSelect: (people) => selected.value = people)),
          Padding(
            padding: const EdgeInsets.all(8.0),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: Text(context.t.cancel)),
                const SizedBox(width: 8),
                ElevatedButton(
                  key: const Key('tag_people_apply'),
                  onPressed: selected.value.isEmpty ? null : () => Navigator.of(context).pop(selected.value),
                  child: Text(context.t.tag),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
