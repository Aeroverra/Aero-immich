import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/widgets/common/tag_picker.dart';

/// Picks the tags a search needs and the tags it leaves out, one list at a time. A tag is in one list at most:
/// picking it in the other list moves it there.
class TagFilterPicker extends HookWidget {
  final Set<String> initialIncluded;
  final Set<String> initialExcluded;
  final void Function(Set<String> includedIds, Set<String> excludedIds) onChanged;

  const TagFilterPicker({
    super.key,
    required this.initialIncluded,
    required this.initialExcluded,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final excludeMode = useState(false);
    final included = useState<Set<String>>(initialIncluded);
    final excluded = useState<Set<String>>(initialExcluded);

    void update(Set<String> picked, {required bool exclude}) {
      if (exclude) {
        excluded.value = picked;
        included.value = included.value.difference(picked);
      } else {
        included.value = picked;
        excluded.value = excluded.value.difference(picked);
      }
      onChanged(included.value, excluded.value);
    }

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: SegmentedButton<bool>(
            key: const Key('tag-filter-mode'),
            segments: [
              ButtonSegment(
                value: false,
                label: Text(context.t.search_include_tags),
                icon: const Icon(Icons.sell_outlined),
              ),
              ButtonSegment(
                value: true,
                label: Text(context.t.search_exclude_tags),
                icon: const Icon(Icons.label_off_outlined),
              ),
            ],
            selected: {excludeMode.value},
            onSelectionChanged: (selection) => excludeMode.value = selection.first,
          ),
        ),
        Expanded(
          // a new picker per list, so each starts from its own selection
          child: excludeMode.value
              ? TagPicker(
                  key: const ValueKey('exclude'),
                  initialSelection: excluded.value,
                  onSelectExistingTag: (tags) => update(tags.map((tag) => tag.id).toSet(), exclude: true),
                )
              : TagPicker(
                  key: const ValueKey('include'),
                  initialSelection: included.value,
                  onSelectExistingTag: (tags) => update(tags.map((tag) => tag.id).toSet(), exclude: false),
                ),
        ),
      ],
    );
  }
}
