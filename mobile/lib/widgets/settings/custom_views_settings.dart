import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/tagging.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/repositories/custom_view_api.repository.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_mobile/widgets/settings/setting_group_title.dart';
import 'package:logging/logging.dart';

final _log = Logger('CustomViewsSettings');

/// The views as the server lists them; views with private access are only listed while private mode is unlocked
final customViewsListProvider = FutureProvider.autoDispose<List<CustomView>>((ref) async {
  ref.watch(privateModeProvider);
  final views = await ref.watch(customViewApiRepositoryProvider).getAll();
  return [...views]..sort((a, b) => a.order.compareTo(b.order));
});

/// A short description of what [view] shows, "Everything, 2 hidden tags"
String customViewSummary(Translations t, CustomView view) {
  final parts = <String>[
    if (view.includeAll) t.custom_view_summary_everything,
    if (!view.includeAll && view.includeUntagged) t.custom_view_summary_untagged,
    if (!view.includeAll && view.includeTagIds.isNotEmpty) t.custom_view_summary_tags(count: view.includeTagIds.length),
    if (view.excludeTagIds.isNotEmpty) t.custom_view_summary_excluded(count: view.excludeTagIds.length),
  ];
  return parts.join(', ');
}

/// Saves [view] on the server and mirrors it locally, so the switcher and the timeline follow before the next sync
Future<CustomView> saveCustomView(WidgetRef ref, CustomView view, {required bool isNew}) async {
  final api = ref.read(customViewApiRepositoryProvider);
  final saved = isNew ? await api.create(view) : await api.update(view);
  final ownerId = ref.read(currentUserProvider)?.id ?? '';
  final local = CustomView(
    id: saved.id,
    ownerId: ownerId,
    name: saved.name,
    order: saved.order,
    isDefault: saved.isDefault,
    access: saved.access,
    includeAll: saved.includeAll,
    includeUntagged: saved.includeUntagged,
    privateAssets: saved.privateAssets,
    includeTagIds: saved.includeTagIds,
    excludeTagIds: saved.excludeTagIds,
  );
  await ref.read(driftProvider).customViewRepository.replaceView(local);
  ref.invalidate(customViewsListProvider);
  return local;
}

/// Settings > Views: the views (list, reorder, default, delete, create and edit, while private mode is unlocked) and
/// the tags (hidden switch, delete with the views that use the tag, review)
class CustomViewsSettings extends ConsumerWidget {
  const CustomViewsSettings({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isSupported = ref.watch(customViewsSupportedProvider);
    final privateMode = ref.watch(privateModeProvider);

    if (!isSupported) {
      return const SizedBox.shrink();
    }

    return ListView(
      padding: const EdgeInsets.only(top: 16, bottom: 48),
      children: [
        SettingGroupTitle(
          title: context.t.custom_views,
          icon: Icons.filter_alt_outlined,
          subtitle: context.t.custom_views_settings_description,
        ),
        if (!privateMode)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              spacing: 12,
              children: [
                Text(context.t.custom_views_require_private_mode, style: context.textTheme.bodyMedium),
                FilledButton.icon(
                  key: const Key('custom-views-unlock'),
                  icon: const Icon(Icons.lock_person_outlined),
                  label: Text(context.t.private_mode_enable),
                  onPressed: () => unawaited(context.pushRoute(PrivatePinAuthRoute())),
                ),
              ],
            ),
          )
        else
          const _ViewList(),
        const SizedBox(height: 24),
        const _TagSettings(),
      ],
    );
  }
}

class _ViewList extends ConsumerWidget {
  const _ViewList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final views = ref.watch(customViewsListProvider);
    final saveError = context.t.errors.unable_to_save_custom_view;
    final deleteError = context.t.errors.unable_to_delete_custom_view;

    void showError(String message) {
      if (context.mounted) {
        ImmichToast.show(context: context, msg: message, toastType: ToastType.error);
      }
    }

    Future<void> reorder(List<CustomView> list, int oldIndex, int newIndex) async {
      final reordered = [...list];
      final moved = reordered.removeAt(oldIndex);
      reordered.insert(newIndex, moved);
      try {
        for (int i = 0; i < reordered.length; i++) {
          if (reordered[i].order != i) {
            await saveCustomView(ref, reordered[i].copyWith(order: i), isNew: false);
          }
        }
      } catch (error, stack) {
        _log.warning('Failed to reorder the views', error, stack);
        showError(saveError);
      }
      ref.invalidate(customViewsListProvider);
    }

    Future<void> makeDefault(CustomView view, bool isDefault) async {
      try {
        await saveCustomView(ref, view.copyWith(isDefault: isDefault), isNew: false);
      } catch (error, stack) {
        _log.warning('Failed to change the default view', error, stack);
        showError(saveError);
      }
    }

    Future<void> delete(CustomView view) async {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(context.t.custom_view_delete),
          content: Text(context.t.custom_view_delete_confirmation(name: view.name)),
          actions: [
            TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(context.t.cancel)),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(context.t.delete, style: TextStyle(color: context.colorScheme.error)),
            ),
          ],
        ),
      );
      if (confirmed != true) {
        return;
      }
      try {
        await ref.read(customViewApiRepositoryProvider).delete(view.id);
        await ref.read(driftProvider).customViewRepository.deleteViews([view.id]);
        if (ref.read(activeViewProvider) == view.id) {
          ref.read(activeViewProvider.notifier).resetToDefault();
        }
        ref.invalidate(customViewsListProvider);
      } catch (error, stack) {
        _log.warning('Failed to delete view ${view.id}', error, stack);
        showError(deleteError);
      }
    }

    return views.when(
      loading: () => const Padding(
        padding: EdgeInsets.all(24),
        child: Center(child: CircularProgressIndicator()),
      ),
      error: (error, _) =>
          Padding(padding: const EdgeInsets.all(20), child: Text(context.t.errors.unable_to_load_custom_views)),
      data: (list) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (list.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
              child: Text(context.t.custom_views_empty),
            ),
          ReorderableListView(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            buildDefaultDragHandles: false,
            onReorderItem: (oldIndex, newIndex) => unawaited(reorder(list, oldIndex, newIndex)),
            children: [
              for (final (index, view) in list.indexed)
                ListTile(
                  key: Key('custom-view-setting-${view.id}'),
                  leading: ReorderableDragStartListener(index: index, child: const Icon(Icons.drag_handle)),
                  title: Row(
                    spacing: 8,
                    children: [
                      Flexible(child: Text(view.name, overflow: TextOverflow.ellipsis)),
                      if (view.isDefault)
                        Chip(label: Text(context.t.custom_view_default), visualDensity: VisualDensity.compact),
                      if (view.access == ViewAccess.locked) const Icon(Icons.lock_outline_rounded, size: 18),
                      if (view.access == ViewAccess.private) const Icon(Icons.lock_person_outlined, size: 18),
                    ],
                  ),
                  subtitle: Text(customViewSummary(context.t, view)),
                  onTap: () => unawaited(context.pushRoute(CustomViewEditorRoute(view: view))),
                  trailing: PopupMenuButton<String>(
                    onSelected: (value) => unawaited(switch (value) {
                      'default' => makeDefault(view, !view.isDefault),
                      'delete' => delete(view),
                      _ => context.pushRoute(CustomViewEditorRoute(view: view)),
                    }),
                    itemBuilder: (_) => [
                      PopupMenuItem(value: 'edit', child: Text(context.t.custom_view_edit)),
                      PopupMenuItem(
                        value: 'default',
                        enabled: view.isDefault || view.access == ViewAccess.open,
                        child: Text(
                          view.isDefault ? context.t.custom_view_unset_default : context.t.custom_view_set_default,
                        ),
                      ),
                      PopupMenuItem(value: 'delete', child: Text(context.t.custom_view_delete)),
                    ],
                  ),
                ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton.icon(
                key: const Key('custom-view-create'),
                icon: const Icon(Icons.add),
                label: Text(context.t.custom_view_create),
                onPressed: () => unawaited(context.pushRoute(CustomViewEditorRoute(order: list.length))),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _TagSettings extends ConsumerWidget {
  const _TagSettings();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tree = ref.watch(tagTreeProvider);
    final service = ref.watch(taggingServiceProvider);

    void showError() {
      if (context.mounted) {
        ImmichToast.show(context: context, msg: context.t.scaffold_body_error_occurred, toastType: ToastType.error);
      }
    }

    Future<void> setHidden(TagEntry tag, bool isHidden) async {
      try {
        await service.setHidden(tag, isHidden);
      } catch (error, stack) {
        _log.warning('Failed to update tag ${tag.id}', error, stack);
        showError();
      }
    }

    Future<void> delete(TagEntry tag) async {
      List<CustomView> views;
      try {
        views = await service.viewsUsingTag(tag.id);
      } catch (error, stack) {
        _log.warning('Failed to read the views using tag ${tag.id}', error, stack);
        views = const [];
      }
      if (!context.mounted) {
        return;
      }

      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(context.t.delete_tag),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            spacing: 12,
            children: [
              Text(context.t.delete_tag_confirmation_prompt(tagName: tag.value)),
              if (views.isNotEmpty)
                Text(
                  tagUsedByViewsMessage(context.t, views),
                  key: const Key('delete-tag-views-warning'),
                  style: TextStyle(color: context.colorScheme.error),
                ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(context.t.cancel)),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(context.t.delete, style: TextStyle(color: context.colorScheme.error)),
            ),
          ],
        ),
      );
      if (confirmed != true) {
        return;
      }
      try {
        await service.deleteTag(tag.id);
      } catch (error, stack) {
        _log.warning('Failed to delete tag ${tag.id}', error, stack);
        showError();
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SettingGroupTitle(title: context.t.tags, icon: Icons.sell_outlined),
        ListTile(
          key: const Key('tag-review-open'),
          leading: const Icon(Icons.fact_check_outlined),
          title: Text(context.t.tag_review),
          subtitle: Text(context.t.tag_review_description),
          onTap: () => unawaited(context.pushRoute(TagReviewRoute())),
        ),
        for (final entry in tree)
          ListTile(
            key: Key('tag-setting-${entry.tag.id}'),
            contentPadding: EdgeInsets.only(left: 20.0 + entry.depth * 20, right: 8),
            title: Text(entry.tag.name),
            subtitle: entry.tag.isHidden ? Text(context.t.tag_hidden) : null,
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Tooltip(
                  message: context.t.tag_hidden_description,
                  child: Switch(
                    value: entry.tag.isHidden,
                    onChanged: (value) => unawaited(setHidden(entry.tag, value)),
                  ),
                ),
                IconButton(
                  tooltip: context.t.delete_tag,
                  icon: const Icon(Icons.delete_outline),
                  onPressed: () => unawaited(delete(entry.tag)),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// "The views Gym and Travel use this tag and lose those rules."
String tagUsedByViewsMessage(Translations t, List<CustomView> views) {
  final names = views.map((view) => view.name).join(', ');
  final message = t.delete_tag_used_by_views(count: views.length);
  return message.contains('{views}') ? message.replaceAll('{views}', names) : '$message ($names)';
}
