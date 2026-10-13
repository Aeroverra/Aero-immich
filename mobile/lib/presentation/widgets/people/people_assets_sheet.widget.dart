import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/person.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/string_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/images/remote_image_provider.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/infrastructure/people.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/utils/image_url_builder.dart';
import 'package:logging/logging.dart';

final _log = Logger('PeopleAssetsSheet');

/// Opens the sheet that adds people to and takes people off [assetIds]. Resolves to whether anything changed.
Future<bool> showPeopleAssetsSheet(BuildContext context, List<String> assetIds) async {
  var changed = false;
  await showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.7,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      builder: (context, controller) =>
          PeopleAssetsSheet(assetIds: assetIds, scrollController: controller, onChanged: () => changed = true),
    ),
  );
  return changed;
}

/// Every person with a checkbox that shows whether all, some or none of the assets have them. Tapping adds the person
/// to all of them without a face box, or takes them off when all of them have the person; a face of theirs found in
/// the picture stays.
class PeopleAssetsSheet extends HookConsumerWidget {
  final List<String> assetIds;
  final ScrollController? scrollController;
  final VoidCallback? onChanged;

  const PeopleAssetsSheet({super.key, required this.assetIds, this.scrollController, this.onChanged});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final service = ref.watch(peopleServiceProvider);
    final people = ref.watch(getAllPeopleProvider);
    final query = useState('');
    final counts = useState<Map<String, ({int count, int removable})>>(const {});
    final busy = useState<Set<String>>(const {});
    final total = assetIds.length;

    Future<void> reloadCounts() async {
      final result = await service.countOnAssets(assetIds);
      if (context.mounted) {
        counts.value = result;
      }
    }

    useEffect(() {
      unawaited(reloadCounts());
      return null;
    }, const []);

    Future<void> toggle(Person person) async {
      if (busy.value.contains(person.id)) {
        return;
      }
      busy.value = {...busy.value, person.id};
      try {
        final count = counts.value[person.id]?.count ?? 0;
        if (count >= total) {
          final result = await service.removeFromAssets(person.id, assetIds);
          if (result.kept.isNotEmpty && context.mounted) {
            ref.read(toastServiceProvider).info(context.t.people_kept_on_faces(count: result.kept.length));
          }
        } else {
          await service.addToAssets(person.id, assetIds);
        }
        onChanged?.call();
        await reloadCounts();
      } catch (error, stack) {
        _log.warning('Failed to change the people of the assets', error, stack);
        if (context.mounted) {
          ref.read(toastServiceProvider).error(context.t.scaffold_body_error_occurred);
        }
      } finally {
        if (context.mounted) {
          busy.value = {...busy.value}..remove(person.id);
        }
      }
    }

    Widget personTile(Person person) {
      final count = counts.value[person.id]?.count ?? 0;
      final bool? checked = count == 0 ? false : (count >= total ? true : null);
      final isBusy = busy.value.contains(person.id);
      return ListTile(
        key: Key('person-${person.id}'),
        leading: CircleAvatar(
          backgroundImage: RemoteImageProvider(
            url: getFaceThumbnailUrl(
              person.id,
              updatedAt: person.updatedAt,
              scope: ref.watch(personThumbnailScopeProvider),
            ),
          ),
        ),
        title: Text(person.name.nullIfEmpty ?? context.t.no_name),
        subtitle: checked == null ? Text('$count / $total') : null,
        trailing: isBusy
            ? const SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2))
            : Checkbox(tristate: true, value: checked, onChanged: (_) => unawaited(toggle(person))),
        onTap: () => unawaited(toggle(person)),
      );
    }

    final lowerQuery = query.value.trim().toLowerCase().removeDiacritics();
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Text(context.t.people_edit_assets, style: context.textTheme.titleMedium),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: TextField(
            onChanged: (value) => query.value = value,
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search),
              hintText: context.t.search_people,
              filled: true,
              border: const OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(24))),
              isDense: true,
            ),
          ),
        ),
        Expanded(
          child: people.when(
            data: (all) {
              final matches = [
                for (final person in all)
                  if (lowerQuery.isEmpty || person.name.toLowerCase().removeDiacritics().contains(lowerQuery)) person,
              ];
              // the people already on the assets first, the rest keep their order
              final onAssets = matches.where((person) => (counts.value[person.id]?.count ?? 0) > 0);
              final others = matches.where((person) => (counts.value[person.id]?.count ?? 0) == 0);
              return ListView(
                controller: scrollController,
                children: [
                  for (final person in [...onAssets, ...others]) personTile(person),
                ],
              );
            },
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (error, stack) => Center(child: Text(context.t.scaffold_body_error_occurred)),
          ),
        ),
      ],
    );
  }
}
