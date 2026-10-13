import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/services/hidden_asset.service.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/timeline/custom_view_switcher_button.widget.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart' as beta_asset_provider;
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/services/deep_link.service.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

final hiddenAssetServiceProvider = Provider(
  (ref) => HiddenAssetService(ref.watch(beta_asset_provider.assetServiceProvider)),
);

/// Opened by a link to an asset the session does not show: private while private mode is off, or hidden by the
/// applied view. Asks for private mode first (biometrics, then the PIN) when nothing else could show it, then offers
/// the views that show it and switches to the chosen one, and finally replaces itself with the viewer. Leaving any
/// step returns to where the user came from.
@RoutePage()
class HiddenAssetPage extends HookConsumerWidget {
  final String assetId;
  final String? albumId;

  const HiddenAssetPage({super.key, required this.assetId, this.albumId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    useEffect(() {
      unawaited(_resolve(context, ref));
      return null;
    }, const []);

    return const Scaffold(body: Center(child: CircularProgressIndicator()));
  }

  Future<HiddenAssetOptions> _options(WidgetRef ref) async {
    await loadCustomViews(ref);
    return ref
        .read(hiddenAssetServiceProvider)
        .getOptions(
          assetId,
          HiddenAssetContext(
            filter: ref.read(privateModeFilterProvider),
            appliedView: ref.read(appliedViewProvider),
            switchableViews: ref.read(switchableViewsProvider),
            allViews: ref.read(localViewsProvider).valueOrNull ?? const [],
            tags: ref.read(localTagsProvider).valueOrNull ?? const [],
          ),
        );
  }

  Future<void> _resolve(BuildContext context, WidgetRef ref) async {
    var options = await _options(ref);
    if (!context.mounted) {
      return;
    }

    if (!options.visible && !options.hasViews && !ref.read(privateModeProvider)) {
      await context.pushRoute(PrivatePinAuthRoute(description: context.t.hidden_asset_unlock_description));
      if (!context.mounted) {
        return;
      }
      if (!ref.read(privateModeProvider)) {
        return _leave(context);
      }
      options = await _options(ref);
      if (!context.mounted) {
        return;
      }
    }

    if (options.visible) {
      return _open(context, ref);
    }

    if (!options.hasViews) {
      ImmichToast.show(context: context, msg: context.t.hidden_asset_not_found, toastType: ToastType.error);
      return _leave(context);
    }

    final choice = await showModalBottomSheet<HiddenAssetViewChoice>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (_) => HiddenAssetViewSheet(
        views: options.views,
        allPhotos: options.allPhotos,
        currentViewName: ref.read(appliedViewProvider)?.name ?? context.t.custom_view_all_photos,
      ),
    );
    if (!context.mounted) {
      return;
    }
    if (choice == null) {
      return _leave(context);
    }

    final view = choice.view;
    final switched = view == null
        ? await _switchToAllPhotos(context, ref)
        : await switchToCustomView(context, ref, view);
    if (!context.mounted) {
      return;
    }
    if (!switched) {
      return _leave(context);
    }
    return _open(context, ref);
  }

  Future<bool> _switchToAllPhotos(BuildContext context, WidgetRef ref) async {
    try {
      await ref.read(activeViewProvider.notifier).switchTo(null);
      return true;
    } catch (_) {
      if (context.mounted) {
        ImmichToast.show(
          context: context,
          msg: context.t.errors.unable_to_switch_custom_view,
          toastType: ToastType.error,
        );
      }
      return false;
    }
  }

  Future<void> _open(BuildContext context, WidgetRef ref) async {
    final asset = await ref.read(beta_asset_provider.assetServiceProvider).getRemoteAsset(assetId);
    if (!context.mounted) {
      return;
    }
    if (asset == null) {
      return _leave(context);
    }
    // read now: the service carries the private mode filter, which may have just changed
    final route = await ref.read(deepLinkServiceProvider).buildAssetViewerRoute(asset, ref, albumId: albumId);
    if (context.mounted) {
      await context.replaceRoute(route);
    }
  }

  Future<void> _leave(BuildContext context) async {
    final router = context.router;
    if (router.canPop()) {
      await router.maybePop();
      return;
    }
    await router.replaceAll([
      TabShellRoute(children: [MainTimelineRoute()]),
    ]);
  }
}

/// The view the user picked; a null [view] is all photos (the user has no default view)
class HiddenAssetViewChoice {
  final CustomView? view;

  const HiddenAssetViewChoice(this.view);
}

/// Tells the user that the current view hides the asset and lists the views that show it. Picking one closes the sheet
/// with it; the caller switches, because the app as a whole changes to that view.
class HiddenAssetViewSheet extends StatelessWidget {
  final List<CustomView> views;
  final bool allPhotos;
  final String currentViewName;

  const HiddenAssetViewSheet({super.key, required this.views, required this.allPhotos, required this.currentViewName});

  @override
  Widget build(BuildContext context) {
    Widget option(CustomView? view) {
      final subtitle = switch (view) {
        null => null,
        _ when view.isDefault => context.t.custom_view_default,
        _ when view.access == ViewAccess.locked => context.t.custom_view_access_locked,
        _ when view.access == ViewAccess.private => context.t.custom_view_access_private,
        _ => null,
      };
      final icon = switch (view?.access) {
        ViewAccess.locked => Icons.lock_outline_rounded,
        ViewAccess.private => Icons.lock_person_outlined,
        _ => Icons.visibility_outlined,
      };

      return ListTile(
        key: Key(view == null ? 'hidden-asset-all-photos' : 'hidden-asset-view-${view.id}'),
        leading: Icon(icon, color: context.primaryColor),
        title: Text(view?.name ?? context.t.custom_view_all_photos),
        subtitle: subtitle == null ? null : Text(subtitle),
        trailing: const Icon(Icons.chevron_right_rounded),
        onTap: () => Navigator.of(context).pop(HiddenAssetViewChoice(view)),
      );
    }

    return SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
              child: Row(
                children: [
                  Icon(Icons.visibility_off_outlined, color: context.primaryColor),
                  const SizedBox(width: 12),
                  Text(context.t.hidden_asset_title, style: context.textTheme.titleMedium),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
              child: Text(
                context.t.hidden_asset_views_description(name: currentViewName),
                style: context.textTheme.bodyMedium,
              ),
            ),
            if (allPhotos) option(null),
            for (final view in views) option(view),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: OutlinedButton(
                key: const Key('hidden-asset-cancel'),
                onPressed: () => Navigator.of(context).pop(),
                child: Text(context.t.cancel),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
