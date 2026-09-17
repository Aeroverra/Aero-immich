import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/tagging.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:logging/logging.dart';

final _log = Logger('TagAssetsSheet');

/// Opens the sheet that adds tags to and removes tags from [assetIds]
Future<void> showTagAssetsSheet(BuildContext context, List<String> assetIds) {
  return showModalBottomSheet(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.7,
      minChildSize: 0.4,
      maxChildSize: 0.95,
      builder: (context, controller) => TagAssetsSheet(assetIds: assetIds, scrollController: controller),
    ),
  );
}

/// Recent tags, a search that can create a tag, and every tag as a tree. Each tag shows whether all, some or none of
/// the assets carry it; tapping adds it to all of them, or removes it when all of them carry it.
class TagAssetsSheet extends HookConsumerWidget {
  final List<String> assetIds;
  final ScrollController? scrollController;

  const TagAssetsSheet({super.key, required this.assetIds, this.scrollController});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final service = ref.watch(taggingServiceProvider);
    final tree = ref.watch(tagTreeProvider);
    final query = useState('');
    final counts = useState<Map<String, int>>(const {});
    final busy = useState<Set<String>>(const {});
    final searchController = useTextEditingController();

    Future<void> reloadCounts() async {
      final result = await service.countTagged(assetIds);
      if (context.mounted) {
        counts.value = result;
      }
    }

    useEffect(() {
      unawaited(reloadCounts());
      return null;
    }, const []);

    Future<void> run(String key, Future<void> Function() action) async {
      if (busy.value.contains(key)) {
        return;
      }
      busy.value = {...busy.value, key};
      try {
        await action();
        await reloadCounts();
      } catch (error, stack) {
        _log.warning('Failed to update tags', error, stack);
        if (context.mounted) {
          ImmichToast.show(context: context, msg: context.t.errors.failed_to_tag_assets, toastType: ToastType.error);
        }
      } finally {
        if (context.mounted) {
          busy.value = {...busy.value}..remove(key);
        }
      }
    }

    Future<void> toggle(TagEntry tag) => run(tag.id, () async {
      final count = counts.value[tag.id] ?? 0;
      if (count >= assetIds.length) {
        await service.removeTag(tag.id, assetIds);
      } else {
        await service.addTag(tag.id, assetIds);
      }
    });

    Future<void> create(String path) => run('create:$path', () async {
      final tag = await service.createTag(path);
      await service.addTag(tag.id, assetIds);
      searchController.clear();
      query.value = '';
    });

    final trimmed = query.value.trim().replaceAll(RegExp(r'^/+|/+$'), '');
    final lowerQuery = trimmed.toLowerCase();
    final visibleIds = {for (final entry in tree) entry.tag.id};
    final recent = [
      for (final id in service.recentTagIds)
        if (visibleIds.contains(id)) tree.firstWhere((entry) => entry.tag.id == id).tag,
    ];
    final matches = trimmed.isEmpty
        ? tree
        : tree.where((entry) => entry.tag.value.toLowerCase().contains(lowerQuery)).toList();
    final canCreate = trimmed.isNotEmpty && !tree.any((entry) => entry.tag.value.toLowerCase() == lowerQuery);

    Widget tagTile(TagEntry tag, {int depth = 0, bool showPath = false}) {
      final count = counts.value[tag.id] ?? 0;
      final isBusy = busy.value.contains(tag.id);
      final bool? checked = count == 0 ? false : (count >= assetIds.length ? true : null);
      return ListTile(
        key: Key('tag-${tag.id}'),
        contentPadding: EdgeInsets.only(left: 16.0 + depth * 20, right: 16),
        leading: isBusy
            ? const SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2))
            : Checkbox(tristate: true, value: checked, onChanged: (_) => unawaited(toggle(tag))),
        title: Text(showPath ? tag.value : tag.name),
        subtitle: checked == null ? Text('$count / ${assetIds.length}') : null,
        onTap: () => unawaited(toggle(tag)),
      );
    }

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: TextField(
            controller: searchController,
            onChanged: (value) => query.value = value,
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search),
              hintText: context.t.search_tags,
              filled: true,
              border: const OutlineInputBorder(borderRadius: BorderRadius.all(Radius.circular(24))),
              isDense: true,
            ),
          ),
        ),
        Expanded(
          child: ListView(
            controller: scrollController,
            children: [
              if (canCreate)
                ListTile(
                  key: const Key('tag-create'),
                  leading: busy.value.contains('create:$trimmed')
                      ? const SizedBox.square(dimension: 24, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.add),
                  title: Text(context.t.create_tag),
                  subtitle: Text(trimmed),
                  onTap: () => unawaited(create(trimmed)),
                ),
              if (trimmed.isEmpty && recent.isNotEmpty) ...[
                _SectionTitle(context.t.recent),
                for (final tag in recent) tagTile(tag, showPath: true),
                const Divider(),
              ],
              if (trimmed.isEmpty) _SectionTitle(context.t.tags),
              for (final entry in matches)
                tagTile(entry.tag, depth: trimmed.isEmpty ? entry.depth : 0, showPath: trimmed.isNotEmpty),
              if (tree.isEmpty && !canCreate)
                Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(context.t.tag_not_found_question.replaceAll(RegExp('<[^>]*>'), '')),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final String title;

  const _SectionTitle(this.title);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Text(title, style: context.textTheme.labelLarge?.copyWith(color: context.primaryColor)),
    );
  }
}
