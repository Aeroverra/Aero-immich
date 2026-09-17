import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/remove_tag.action.dart';
import 'package:immich_mobile/presentation/actions/tag.action.dart';
import 'package:immich_mobile/presentation/widgets/bottom_sheet/base_bottom_sheet.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/tagging.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';

/// Review photos by tag: pick a tag (for example Unreviewed), select the photos that are fine and remove the tag from
/// them, or add another tag. Lists only the photos the applied view shows and only tags the user may see now.
@RoutePage()
class TagReviewPage extends HookConsumerWidget {
  final String? tagId;

  const TagReviewPage({super.key, this.tagId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tree = ref.watch(tagTreeProvider);
    final selectedId = useState<String?>(tagId);
    TagEntry? selected;
    for (final entry in tree) {
      if (entry.tag.id == selectedId.value) {
        selected = entry.tag;
      }
    }

    Future<void> pickTag() async {
      final picked = await showTagPicker(context);
      if (picked != null) {
        selectedId.value = picked.id;
      }
    }

    if (selected == null) {
      return Scaffold(
        appBar: AppBar(title: Text(context.t.tag_review)),
        body: _TagList(
          header: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: Text(context.t.tag_review_description, style: context.textTheme.bodyMedium),
          ),
          onSelected: (tag) => selectedId.value = tag.id,
        ),
      );
    }

    final tag = selected;
    return ProviderScope(
      key: ValueKey(tag.id),
      overrides: [
        timelineServiceProvider.overrideWith((ref) {
          final user = ref.watch(currentUserProvider);
          if (user == null) {
            throw Exception('User must be logged in to review tags');
          }

          final timelineService = ref.watch(timelineFactoryProvider).tagged(user.id, {tag.id});
          ref.onDispose(timelineService.dispose);
          return timelineService;
        }),
      ],
      child: Timeline(
        appBar: SliverAppBar(
          floating: true,
          title: Text(tag.value),
          actions: [
            IconButton(
              key: const Key('tag-review-pick'),
              tooltip: context.t.tag_review_pick,
              icon: const Icon(Icons.sell_outlined),
              onPressed: () => unawaited(pickTag()),
            ),
          ],
        ),
        bottomSheet: _TagReviewBottomSheet(tagId: tag.id),
      ),
    );
  }
}

/// Shows the visible tags as a tree and returns the one picked
Future<TagEntry?> showTagPicker(BuildContext context) {
  return showModalBottomSheet<TagEntry>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (sheetContext) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.6,
      maxChildSize: 0.95,
      builder: (_, controller) => _TagList(
        controller: controller,
        header: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Text(context.t.tag_review_pick, style: context.textTheme.titleMedium),
        ),
        onSelected: (tag) => Navigator.of(sheetContext).pop(tag),
      ),
    ),
  );
}

class _TagList extends ConsumerWidget {
  final Widget? header;
  final ScrollController? controller;
  final void Function(TagEntry tag) onSelected;

  const _TagList({this.header, this.controller, required this.onSelected});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tree = ref.watch(tagTreeProvider);
    return ListView(
      controller: controller,
      children: [
        ?header,
        for (final entry in tree)
          ListTile(
            key: Key('tag-review-${entry.tag.id}'),
            contentPadding: EdgeInsets.only(left: 16.0 + entry.depth * 20, right: 16),
            leading: const Icon(Icons.sell_outlined),
            title: Text(entry.tag.name),
            onTap: () => onSelected(entry.tag),
          ),
      ],
    );
  }
}

class _TagReviewBottomSheet extends StatelessWidget {
  final String tagId;

  const _TagReviewBottomSheet({required this.tagId});

  @override
  Widget build(BuildContext context) {
    return BaseBottomSheet(
      initialChildSize: 0.2,
      minChildSize: 0.2,
      maxChildSize: 0.4,
      shouldCloseOnMinExtent: false,
      actions: [
        ActionColumnButton(
          action: RemoveTagAction(source: .timeline, tagId: tagId),
        ),
        const ActionColumnButton(action: TagAction(source: .timeline)),
      ],
    );
  }
}
