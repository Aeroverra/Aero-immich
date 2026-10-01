import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/presentation/widgets/feature_message/feature_message_dialog.widget.dart';
import 'package:immich_mobile/presentation/widgets/memory/memory_lane.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/custom_view_switcher_button.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/group_auto_stacks_button.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/feature_message.provider.dart';
import 'package:immich_mobile/providers/infrastructure/memory.provider.dart';
import 'package:immich_mobile/widgets/common/immich_sliver_app_bar.dart';

@RoutePage()
class MainTimelinePage extends ConsumerStatefulWidget {
  const MainTimelinePage({super.key, this.scrollToDate});

  /// Set when the page is pushed on top of the tab shell by "view in timeline". The timeline opens at
  /// this date and gets a back button, so the page the jump came from (for example the search results)
  /// is a single pop away, exactly as the user left it. The Photos tab never sets it.
  final DateTime? scrollToDate;

  @override
  ConsumerState<MainTimelinePage> createState() => _MainTimelinePageState();
}

class _MainTimelinePageState extends ConsumerState<MainTimelinePage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) {
        return;
      }
      final service = ref.read(featureMessageServiceProvider);
      if (!service.shouldShow()) {
        return;
      }

      await service.markSeen();
      if (!mounted) {
        return;
      }

      await showFeatureMessageDialog(context);
    });
  }

  @override
  Widget build(BuildContext context) {
    final hasMemories = ref.watch(memoryLaneProvider.select((state) => state.value?.isNotEmpty ?? false));
    return Timeline(
      // The page passes exactly one appBar: anything a feature wants in the top bar goes into this
      // call, as an entry in actions or in the leading slot. A feature that passes its own second
      // appBar argument instead merges into main without a conflict and only fails to compile there.
      appBar: ImmichSliverAppBar(
        floating: true,
        pinned: false,
        snap: false,
        actions: const [CustomViewSwitcherButton(), GroupAutoStacksButton()],
        leading: widget.scrollToDate == null ? null : const BackButton(),
      ),
      topSliverWidget: const SliverToBoxAdapter(child: MemoryLane()),
      topSliverWidgetHeight: hasMemories ? 200 : 0,
      showStorageIndicator: true,
      initialScrollDate: widget.scrollToDate,
    );
  }
}
