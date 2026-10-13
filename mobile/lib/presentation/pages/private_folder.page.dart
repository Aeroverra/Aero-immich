import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/bottom_sheet/private_folder_bottom_sheet.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/widgets/common/mesmerizing_sliver_app_bar.dart';

/// Lists every private asset of the current user. Reachable only while private mode is on
/// (see PrivateGuard); when the mode turns off, e.g. on app pause, the page empties itself
/// because the timeline factory rebuilds with the mode off.
@RoutePage()
class PrivateFolderPage extends ConsumerWidget {
  const PrivateFolderPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isPrivateMode = ref.watch(isPrivateModeProvider);
    if (!isPrivateMode) {
      return Scaffold(
        appBar: AppBar(title: Text(context.t.private_photos)),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text(
              context.t.no_private_photos_message,
              textAlign: TextAlign.center,
              style: context.textTheme.bodyLarge,
            ),
          ),
        ),
      );
    }

    return ProviderScope(
      overrides: [
        timelineServiceProvider.overrideWith((ref) {
          final user = ref.watch(currentUserProvider);
          if (user == null) {
            throw Exception('User must be logged in to access the private folder');
          }

          final timelineService = ref.watch(timelineFactoryProvider).privateFolder(user.id);
          ref.onDispose(timelineService.dispose);
          return timelineService;
        }),
      ],
      child: Timeline(
        appBar: MesmerizingSliverAppBar(title: context.t.private_photos, icon: Icons.lock_person_outlined),
        bottomSheet: const PrivateFolderBottomSheet(),
      ),
    );
  }
}
