import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/tagging.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_mobile/widgets/settings/custom_views_settings.dart';
import 'package:logging/logging.dart';

final _log = Logger('CustomViewEditor');

/// Creates a view, or edits [view]. Views name hidden tags, so the page needs private mode like the server does.
@RoutePage()
class CustomViewEditorPage extends HookConsumerWidget {
  final CustomView? view;

  /// Order of a new view, at the end of the list
  final int order;

  const CustomViewEditorPage({super.key, this.view, this.order = 0});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final initial = view;
    final nameController = useTextEditingController(text: initial?.name ?? '');
    final isDefault = useState(initial?.isDefault ?? false);
    final access = useState(initial?.access ?? ViewAccess.open);
    final includeAll = useState(initial?.includeAll ?? true);
    final includeUntagged = useState(initial?.includeUntagged ?? false);
    final includeTagIds = useState<List<String>>(initial?.includeTagIds ?? const []);
    final excludeTagIds = useState<List<String>>(initial?.excludeTagIds ?? const []);
    final privateAssets = useState(initial?.privateAssets ?? ViewPrivateAssets.unlocked);
    final isSaving = useState(false);
    final privateMode = ref.watch(privateModeProvider);
    final tags = ref.watch(localTagsProvider).valueOrNull ?? const <TagEntry>[];

    if (!privateMode) {
      return Scaffold(
        appBar: AppBar(title: Text(initial == null ? context.t.custom_view_create : context.t.custom_view_edit)),
        body: Padding(padding: const EdgeInsets.all(24), child: Text(context.t.custom_views_require_private_mode)),
      );
    }

    Future<void> save() async {
      final name = nameController.text.trim();
      if (name.isEmpty) {
        return;
      }
      isSaving.value = true;
      final edited = CustomView(
        id: initial?.id ?? '',
        ownerId: initial?.ownerId ?? '',
        name: name,
        order: initial?.order ?? order,
        isDefault: isDefault.value,
        // the default view always has open access
        access: isDefault.value ? ViewAccess.open : access.value,
        includeAll: includeAll.value,
        includeUntagged: includeUntagged.value,
        includeTagIds: includeAll.value ? const [] : includeTagIds.value,
        excludeTagIds: excludeTagIds.value,
        privateAssets: privateAssets.value,
      );
      try {
        final saved = await saveCustomView(ref, edited, isNew: initial == null);
        if (context.mounted) {
          ImmichToast.show(
            context: context,
            msg: context.t.custom_view_saved(name: saved.name),
          );
          await context.maybePop();
        }
      } catch (error, stack) {
        _log.warning('Failed to save the view', error, stack);
        if (context.mounted) {
          ImmichToast.show(
            context: context,
            msg: context.t.errors.unable_to_save_custom_view,
            toastType: ToastType.error,
          );
        }
      } finally {
        if (context.mounted) {
          isSaving.value = false;
        }
      }
    }

    Widget sectionTitle(String title, {String? description}) => Padding(
      padding: const EdgeInsets.fromLTRB(16, 20, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        spacing: 4,
        children: [
          Text(title, style: context.textTheme.titleSmall?.copyWith(color: context.primaryColor)),
          if (description != null) Text(description, style: context.textTheme.bodySmall),
        ],
      ),
    );

    return Scaffold(
      appBar: AppBar(
        title: Text(initial == null ? context.t.custom_view_create : context.t.custom_view_edit),
        actions: [
          TextButton(
            key: const Key('custom-view-save'),
            onPressed: isSaving.value ? null : () => unawaited(save()),
            child: Text(context.t.save),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 48),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
            child: TextField(
              key: const Key('custom-view-name'),
              controller: nameController,
              decoration: InputDecoration(labelText: context.t.name, border: const OutlineInputBorder()),
            ),
          ),
          SwitchListTile(
            key: const Key('custom-view-default'),
            title: Text(context.t.custom_view_default),
            subtitle: Text(context.t.custom_view_access_default_description),
            value: isDefault.value,
            onChanged: (value) => isDefault.value = value,
          ),
          sectionTitle(context.t.custom_view_access, description: context.t.custom_view_access_description),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: SegmentedButton<ViewAccess>(
              segments: [
                ButtonSegment(value: ViewAccess.open, label: Text(context.t.custom_view_access_open)),
                ButtonSegment(
                  value: ViewAccess.locked,
                  icon: const Icon(Icons.lock_outline_rounded),
                  label: Text(context.t.custom_view_access_locked),
                ),
                ButtonSegment(
                  value: ViewAccess.private,
                  icon: const Icon(Icons.lock_person_outlined),
                  label: Text(context.t.custom_view_access_private),
                ),
              ],
              selected: {isDefault.value ? ViewAccess.open : access.value},
              onSelectionChanged: isDefault.value ? null : (selection) => access.value = selection.first,
            ),
          ),
          sectionTitle(context.t.custom_view_include_tags),
          SwitchListTile(
            key: const Key('custom-view-include-all'),
            title: Text(context.t.custom_view_include_all),
            subtitle: Text(context.t.custom_view_include_all_description),
            value: includeAll.value,
            onChanged: (value) => includeAll.value = value,
          ),
          SwitchListTile(
            key: const Key('custom-view-include-untagged'),
            title: Text(context.t.custom_view_include_untagged),
            subtitle: Text(context.t.custom_view_include_untagged_description),
            value: includeAll.value || includeUntagged.value,
            onChanged: includeAll.value ? null : (value) => includeUntagged.value = value,
          ),
          if (!includeAll.value)
            TagRuleSelector(
              key: const Key('custom-view-include-tags'),
              title: context.t.custom_view_include_tags,
              description: context.t.custom_view_tags_include_children,
              tags: tags,
              selectedIds: includeTagIds.value,
              blockedIds: excludeTagIds.value,
              onChanged: (ids) => includeTagIds.value = ids,
            ),
          sectionTitle(context.t.custom_view_exclude_tags, description: context.t.custom_view_exclude_tags_description),
          TagRuleSelector(
            key: const Key('custom-view-exclude-tags'),
            title: context.t.custom_view_exclude_tags,
            description: context.t.custom_view_tags_include_children,
            tags: tags,
            selectedIds: excludeTagIds.value,
            blockedIds: includeAll.value ? const [] : includeTagIds.value,
            onChanged: (ids) => excludeTagIds.value = ids,
          ),
          sectionTitle(context.t.custom_view_private_assets),
          RadioGroup<ViewPrivateAssets>(
            groupValue: privateAssets.value,
            onChanged: (value) => privateAssets.value = value ?? privateAssets.value,
            child: Column(
              children: [
                for (final (value, label) in [
                  (ViewPrivateAssets.hide, context.t.custom_view_private_assets_hide),
                  (ViewPrivateAssets.unlocked, context.t.custom_view_private_assets_unlocked),
                  (ViewPrivateAssets.only, context.t.custom_view_private_assets_only),
                ])
                  RadioListTile<ViewPrivateAssets>(value: value, title: Text(label)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The tags of one rule as chips, with a picker that shows every tag as a tree. A picked parent covers its children,
/// which show as picked; tags of the other rule cannot be picked, a tag is never both included and excluded.
class TagRuleSelector extends ConsumerWidget {
  final String title;
  final String? description;
  final List<TagEntry> tags;
  final List<String> selectedIds;
  final List<String> blockedIds;
  final ValueChanged<List<String>> onChanged;

  const TagRuleSelector({
    super.key,
    required this.title,
    this.description,
    required this.tags,
    required this.selectedIds,
    required this.blockedIds,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final byId = {for (final tag in tags) tag.id: tag};

    Future<void> pick() async {
      final result = await showDialog<List<String>>(
        context: context,
        builder: (_) => _TagTreeDialog(title: title, tags: tags, selectedIds: selectedIds, blockedIds: blockedIds),
      );
      if (result != null) {
        onChanged(result);
      }
    }

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Wrap(
        spacing: 8,
        runSpacing: 4,
        children: [
          for (final id in selectedIds)
            InputChip(label: Text(byId[id]?.value ?? id), onDeleted: () => onChanged([...selectedIds]..remove(id))),
          ActionChip(avatar: const Icon(Icons.add, size: 18), label: Text(context.t.add_tag), onPressed: pick),
        ],
      ),
    );
  }
}

class _TagTreeDialog extends HookWidget {
  final String title;
  final List<TagEntry> tags;
  final List<String> selectedIds;
  final List<String> blockedIds;

  const _TagTreeDialog({required this.title, required this.tags, required this.selectedIds, required this.blockedIds});

  @override
  Widget build(BuildContext context) {
    final selected = useState<Set<String>>(selectedIds.toSet());
    final tree = buildTagTree(tags);
    final parents = {for (final tag in tags) tag.id: tag.parentId};

    bool coveredByAncestor(String id) {
      var parentId = parents[id];
      final seen = <String>{};
      while (parentId != null && seen.add(parentId)) {
        if (selected.value.contains(parentId)) {
          return true;
        }
        parentId = parents[parentId];
      }
      return false;
    }

    return AlertDialog(
      title: Text(title),
      contentPadding: const EdgeInsets.symmetric(vertical: 8),
      content: SizedBox(
        width: double.maxFinite,
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final entry in tree)
              Builder(
                builder: (context) {
                  final id = entry.tag.id;
                  final covered = coveredByAncestor(id);
                  final blocked = blockedIds.contains(id);
                  return CheckboxListTile(
                    key: Key('tag-rule-$id'),
                    contentPadding: EdgeInsets.only(left: 16.0 + entry.depth * 20, right: 16),
                    controlAffinity: ListTileControlAffinity.leading,
                    title: Text(entry.tag.name),
                    value: covered || selected.value.contains(id),
                    onChanged: covered || blocked
                        ? null
                        : (value) => selected.value = value == true
                              ? {...selected.value, id}
                              : ({...selected.value}..remove(id)),
                  );
                },
              ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(context.t.cancel)),
        TextButton(
          onPressed: () => Navigator.of(context).pop([
            // a tag below a picked parent is already covered by it
            for (final id in selected.value)
              if (!coveredByAncestor(id)) id,
          ]),
          child: Text(context.t.done),
        ),
      ],
    );
  }
}
