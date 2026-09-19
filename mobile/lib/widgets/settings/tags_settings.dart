import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/tagging.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_mobile/widgets/settings/setting_group_title.dart';
import 'package:logging/logging.dart';

final _log = Logger('TagsSettings');

/// Every tag that is hidden, directly or through a hidden parent tag, whether or not private mode is unlocked
final effectiveHiddenTagIdsProvider = Provider<Set<String>>(
  (ref) => effectiveHiddenTagIds(ref.watch(localTagsProvider).valueOrNull ?? const []),
);

/// Settings > Tags: review photos by tag, and the tags themselves (rename, hide the name, delete). Nothing here
/// changes or deletes photos; a tag opens a sheet with labeled actions instead of controls on every row
class TagsSettings extends ConsumerWidget {
  const TagsSettings({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tree = ref.watch(tagTreeProvider);
    final hidden = ref.watch(effectiveHiddenTagIdsProvider);

    return ListView(
      padding: const EdgeInsets.only(top: 16, bottom: 48),
      children: [
        SettingGroupTitle(
          title: context.t.tags,
          icon: Icons.sell_outlined,
          subtitle: context.t.tags_settings_description,
        ),
        ListTile(
          key: const Key('tag-review-open'),
          leading: const Icon(Icons.fact_check_outlined),
          title: Text(context.t.tag_review),
          subtitle: Text(context.t.tag_review_description),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => unawaited(context.pushRoute(TagReviewRoute())),
        ),
        const Divider(),
        if (tree.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
            child: Text(context.t.tags_settings_empty),
          ),
        for (final entry in tree)
          ListTile(
            key: Key('tag-setting-${entry.tag.id}'),
            contentPadding: EdgeInsets.only(left: 20.0 + entry.depth * 20, right: 12),
            leading: Icon(
              hidden.contains(entry.tag.id) ? Icons.visibility_off_outlined : Icons.sell_outlined,
              key: hidden.contains(entry.tag.id) ? Key('tag-hidden-icon-${entry.tag.id}') : null,
            ),
            title: Text(entry.tag.name),
            subtitle: hidden.contains(entry.tag.id) ? Text(context.t.tag_name_hidden_marker) : null,
            trailing: const Icon(Icons.chevron_right),
            onTap: () => unawaited(showTagActions(context, entry.tag)),
          ),
      ],
    );
  }
}

/// Opens the actions of [tag]: hide the name, rename and delete, each labeled
Future<void> showTagActions(BuildContext context, TagEntry tag) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  builder: (_) => TagActionsSheet(tag: tag),
);

class TagActionsSheet extends ConsumerStatefulWidget {
  final TagEntry tag;

  const TagActionsSheet({super.key, required this.tag});

  @override
  ConsumerState<TagActionsSheet> createState() => _TagActionsSheetState();
}

class _TagActionsSheetState extends ConsumerState<TagActionsSheet> {
  late TagEntry _tag = widget.tag;

  /// A request is running: the controls stay disabled so a second tap cannot send it again
  bool _busy = false;

  void _snack(ScaffoldMessengerState messenger, String message) {
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  void _error(String message) {
    if (mounted) {
      ImmichToast.show(context: context, msg: message, toastType: ToastType.error);
    }
  }

  Future<T?> _run<T>(Future<T> Function() action) async {
    setState(() => _busy = true);
    try {
      return await action();
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  Future<void> _setHidden(bool isHidden) async {
    if (_busy) {
      return;
    }
    final t = context.t;
    final privateMode = ref.read(privateModeProvider);
    // while locked a hidden tag disappears at once, so say so before it happens
    if (isHidden && !privateMode) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(t.tag_hide_confirm_title),
          content: Text(t.tag_hide_confirm_description(tag: _tag.value)),
          actions: [
            TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(t.cancel)),
            TextButton(
              key: const Key('tag-hide-confirm'),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(t.tag_hide_confirm_action),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) {
        return;
      }
    }

    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    try {
      await _run(() => ref.read(taggingServiceProvider).setHidden(_tag, isHidden));
    } catch (error, stack) {
      _log.warning('Failed to change the hidden flag of tag ${_tag.id}', error, stack);
      _error(t.tag_update_failed(tag: _tag.value));
      return;
    }

    if (!isHidden) {
      _snack(messenger, t.tag_name_shown_snackbar(tag: _tag.value));
    } else if (privateMode) {
      _snack(messenger, t.tag_name_hidden_snackbar(tag: _tag.value));
    } else {
      // the tag is gone from every list until private mode is unlocked, so is this sheet
      _snack(messenger, t.tag_hidden_snackbar(tag: _tag.value));
      if (mounted) {
        navigator.pop();
      }
      return;
    }
    if (mounted) {
      setState(() => _tag = _tag.copyWithHidden(isHidden));
    }
  }

  Future<void> _rename() async {
    final t = context.t;
    final name = await showDialog<String>(
      context: context,
      builder: (_) => _RenameTagDialog(name: _tag.name),
    );
    if (name == null || name == _tag.name || !mounted) {
      return;
    }

    final messenger = ScaffoldMessenger.of(context);
    try {
      final renamed = await _run(() => ref.read(taggingServiceProvider).renameTag(_tag, name));
      if (renamed != null && mounted) {
        setState(() => _tag = renamed);
        _snack(messenger, t.tag_renamed(tag: renamed.value));
      }
    } catch (error, stack) {
      _log.warning('Failed to rename tag ${_tag.id}', error, stack);
      _error(t.tag_update_failed(tag: _tag.value));
    }
  }

  Future<void> _delete() async {
    final t = context.t;
    final service = ref.read(taggingServiceProvider);
    ({List<CustomView> views, ({int assets, int children}) counts})? usage;
    try {
      usage = await _run(() async {
        final views = await service.viewsUsingTag(_tag.id).catchError((Object error, StackTrace stack) {
          _log.warning('Failed to read the views using tag ${_tag.id}', error, stack);
          return const <CustomView>[];
        });
        final counts = await service.countTagUsage(_tag.id);
        return (views: views, counts: counts);
      });
    } catch (error, stack) {
      _log.warning('Failed to count the photos of tag ${_tag.id}', error, stack);
      _error(t.tag_delete_failed(tag: _tag.value));
      return;
    }
    final loaded = usage;
    if (loaded == null || !mounted) {
      return;
    }

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(t.tag_delete_confirm_title(tag: _tag.value)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          spacing: 12,
          children: [
            Text(t.tag_delete_confirm_photos(count: loaded.counts.assets), key: const Key('delete-tag-photo-count')),
            Text(t.tag_delete_confirm_keeps_photos, style: const TextStyle(fontWeight: FontWeight.w600)),
            if (loaded.counts.children > 0) Text(t.tag_delete_confirm_children(count: loaded.counts.children)),
            if (loaded.views.isNotEmpty)
              Text(
                tagUsedByViewsMessage(t, loaded.views),
                key: const Key('delete-tag-views-warning'),
                style: TextStyle(color: dialogContext.colorScheme.error),
              ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(t.cancel)),
          FilledButton(
            key: const Key('delete-tag-confirm'),
            style: FilledButton.styleFrom(
              backgroundColor: dialogContext.colorScheme.error,
              foregroundColor: dialogContext.colorScheme.onError,
            ),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(t.delete_tag),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }

    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    try {
      await _run(() => service.deleteTag(_tag.id));
    } catch (error, stack) {
      _log.warning('Failed to delete tag ${_tag.id}', error, stack);
      _error(t.tag_delete_failed(tag: _tag.value));
      return;
    }
    _snack(messenger, t.tag_deleted(tag: _tag.value));
    if (mounted) {
      navigator.pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final inheritedHidden = !_tag.isHidden && ref.watch(effectiveHiddenTagIdsProvider).contains(_tag.id);

    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ListTile(
            leading: Icon(_tag.isHidden || inheritedHidden ? Icons.visibility_off_outlined : Icons.sell_outlined),
            title: Text(_tag.value, style: context.textTheme.titleMedium),
            trailing: _busy
                ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : null,
          ),
          const Divider(height: 1),
          SwitchListTile(
            key: const Key('tag-hide-switch'),
            secondary: const Icon(Icons.visibility_off_outlined),
            title: Text(context.t.tag_hide_name),
            subtitle: Text(inheritedHidden ? context.t.tag_hide_name_inherited : context.t.tag_hide_name_description),
            value: _tag.isHidden,
            onChanged: _busy ? null : (value) => unawaited(_setHidden(value)),
          ),
          ListTile(
            key: const Key('tag-rename'),
            leading: const Icon(Icons.edit_outlined),
            title: Text(context.t.tag_rename),
            enabled: !_busy,
            onTap: () => unawaited(_rename()),
          ),
          ListTile(
            key: const Key('tag-delete'),
            leading: Icon(Icons.delete_outline, color: context.colorScheme.error),
            title: Text(context.t.delete_tag, style: TextStyle(color: context.colorScheme.error)),
            subtitle: Text(context.t.tag_delete_confirm_keeps_photos),
            enabled: !_busy,
            onTap: () => unawaited(_delete()),
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

class _RenameTagDialog extends StatefulWidget {
  final String name;

  const _RenameTagDialog({required this.name});

  @override
  State<_RenameTagDialog> createState() => _RenameTagDialogState();
}

class _RenameTagDialogState extends State<_RenameTagDialog> {
  late final _controller = TextEditingController(text: widget.name);
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _controller.text.trim();
    if (name.isEmpty || name.contains('/')) {
      setState(() => _error = context.t.tag_name_invalid);
      return;
    }
    Navigator.of(context).pop(name);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(context.t.tag_rename),
      content: TextField(
        key: const Key('tag-rename-field'),
        controller: _controller,
        autofocus: true,
        decoration: InputDecoration(errorText: _error),
        onSubmitted: (_) => _submit(),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(context.t.cancel)),
        TextButton(key: const Key('tag-rename-save'), onPressed: _submit, child: Text(context.t.rename)),
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

extension on TagEntry {
  TagEntry copyWithHidden(bool isHidden) =>
      TagEntry(id: id, ownerId: ownerId, value: value, parentId: parentId, color: color, isHidden: isHidden);
}
