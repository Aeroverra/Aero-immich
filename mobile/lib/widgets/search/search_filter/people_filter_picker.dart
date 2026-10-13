import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/widgets/search/search_filter/people_picker.dart';

/// The face options of a people search, each one side or the other or not set:
/// - onlyPeople: with people picked, nobody else in the photo (true) or someone else too (false); faces without a
///   name count as someone else
/// - hasPeople: any face (true) or none at all (false), which sets everything else aside
/// - hasNamedFaces: someone named (true) or nobody named, faces or not (false), which sets the picked people aside
/// - hasUnnamedFaces: a face nobody has named (true) or no such face (false)
typedef PeopleFilterOptions = ({bool? onlyPeople, bool? hasPeople, bool? hasNamedFaces, bool? hasUnnamedFaces});

const PeopleFilterOptions noPeopleFilterOptions = (
  onlyPeople: null,
  hasPeople: null,
  hasNamedFaces: null,
  hasUnnamedFaces: null,
);

/// The label of the People filter chip, empty when nothing is picked
String peopleFilterLabel(BuildContext context, Set<Person> people, PeopleFilterOptions options) {
  final (:onlyPeople, :hasPeople, :hasNamedFaces, :hasUnnamedFaces) = options;
  if (hasPeople == false) {
    return context.t.search_filter_no_people;
  }

  final names = people.map((person) => person.name != '' ? person.name : context.t.no_name).join(', ');
  final picked = switch ((hasNamedFaces, names.isNotEmpty, onlyPeople)) {
    (false, _, _) => context.t.search_filter_no_named_people,
    (_, true, true) => context.t.search_filter_only_people_title(people: names),
    (_, true, false) => context.t.search_filter_with_others_title(people: names),
    (_, true, null) => names,
    (true, false, _) => context.t.search_filter_with_named_people,
    _ => '',
  };
  final unnamed = switch (hasUnnamedFaces) {
    true => context.t.search_filter_with_unnamed_faces,
    false => context.t.search_filter_no_unnamed_faces,
    null => '',
  };
  final parts = [picked, unnamed].where((part) => part.isNotEmpty).toList();
  // anyone at all is implied by every other option
  if (parts.isEmpty && hasPeople == true) {
    return context.t.search_filter_with_people;
  }
  return parts.join(' · ');
}

/// Picks the people a search looks for, with the face options above the list as pairs: one side, the other, or
/// neither (tapping the picked side again). No people and no named people set the picked people aside without
/// forgetting them.
class PeopleFilterPicker extends HookWidget {
  final Set<Person> initialPeople;
  final PeopleFilterOptions initialOptions;
  final void Function(Set<Person> people, PeopleFilterOptions options) onChanged;

  const PeopleFilterPicker({
    super.key,
    required this.initialPeople,
    required this.initialOptions,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final people = useState<Set<Person>>(initialPeople);
    final options = useState<PeopleFilterOptions>(initialOptions);
    final (:onlyPeople, :hasPeople, :hasNamedFaces, :hasUnnamedFaces) = options.value;
    final noFaces = hasPeople == false;
    final peopleSetAside = noFaces || hasNamedFaces == false;
    final canPickOnly = people.value.isNotEmpty && !peopleSetAside;

    void setOptions(PeopleFilterOptions value) {
      options.value = value;
      onChanged(people.value, value);
    }

    void setPeople(Set<Person> value) {
      people.value = value;
      onChanged(value, options.value);
    }

    Widget pair({
      required String keyName,
      required bool? value,
      required bool enabled,
      required (String, String) labels,
      required (String, String) descriptions,
      required void Function(bool? value) onChanged,
    }) {
      FilterChip side(bool sideValue, String label, String description) => FilterChip(
        key: Key('people-filter-$keyName-$sideValue'),
        label: Text(label),
        tooltip: description,
        selected: enabled && value == sideValue,
        onSelected: enabled ? (_) => onChanged(value == sideValue ? null : sideValue) : null,
      );

      return Wrap(
        spacing: 8,
        runSpacing: 4,
        children: [side(true, labels.$1, descriptions.$1), side(false, labels.$2, descriptions.$2)],
      );
    }

    final t = context.t;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              pair(
                keyName: 'only',
                value: onlyPeople,
                enabled: canPickOnly,
                labels: (t.search_filter_only_people, t.search_filter_with_others),
                descriptions: (t.search_filter_only_people_description, t.search_filter_with_others_description),
                onChanged: (value) => setOptions((
                  onlyPeople: value,
                  hasPeople: hasPeople,
                  hasNamedFaces: hasNamedFaces,
                  hasUnnamedFaces: hasUnnamedFaces,
                )),
              ),
              pair(
                keyName: 'named',
                value: hasNamedFaces,
                enabled: !noFaces,
                labels: (t.search_filter_with_named_people, t.search_filter_no_named_people),
                descriptions: (
                  t.search_filter_with_named_people_description,
                  t.search_filter_no_named_people_description,
                ),
                onChanged: (value) => setOptions((
                  onlyPeople: onlyPeople,
                  hasPeople: hasPeople,
                  hasNamedFaces: value,
                  hasUnnamedFaces: hasUnnamedFaces,
                )),
              ),
              pair(
                keyName: 'unnamed',
                value: hasUnnamedFaces,
                enabled: !noFaces,
                labels: (t.search_filter_with_unnamed_faces, t.search_filter_no_unnamed_faces),
                descriptions: (
                  t.search_filter_with_unnamed_faces_description,
                  t.search_filter_no_unnamed_faces_description,
                ),
                onChanged: (value) => setOptions((
                  onlyPeople: onlyPeople,
                  hasPeople: hasPeople,
                  hasNamedFaces: hasNamedFaces,
                  hasUnnamedFaces: value,
                )),
              ),
              pair(
                keyName: 'any',
                value: hasPeople,
                enabled: true,
                labels: (t.search_filter_with_people, t.search_filter_no_people),
                descriptions: (t.search_filter_with_people_description, t.search_filter_no_people_description),
                onChanged: (value) => setOptions((
                  onlyPeople: onlyPeople,
                  hasPeople: value,
                  hasNamedFaces: hasNamedFaces,
                  hasUnnamedFaces: hasUnnamedFaces,
                )),
              ),
            ],
          ),
        ),
        if (onlyPeople != null && canPickOnly)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
            child: Text(
              onlyPeople ? t.search_filter_only_people_description : t.search_filter_with_others_description,
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceSecondary),
            ),
          ),
        Expanded(
          child: IgnorePointer(
            ignoring: peopleSetAside,
            child: Opacity(
              opacity: peopleSetAside ? 0.4 : 1,
              child: PeoplePicker(onSelect: setPeople, initialSelection: initialPeople),
            ),
          ),
        ),
      ],
    );
  }
}
