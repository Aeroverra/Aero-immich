import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/widgets/album/private_albums_dialog.widget.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/routes.provider.dart';
import 'package:immich_mobile/services/toast.service.dart';
import 'package:immich_mobile/utils/error_handler.dart';

/// Owned remote assets of the selection that are not private yet. Marking never needs private mode
/// (like moving to the locked folder), it is only withheld inside the locked and private folders.
final _markTargetsProvider = Provider.family.autoDispose<List<String>, ActionSource>((ref, source) {
  if (ref.watch(inLockedViewProvider) || ref.watch(inPrivateViewProvider)) {
    return const [];
  }

  return ref.watch(ownedAssetsActionProvider(source)).private(isPrivate: false).map((asset) => asset.id).toList();
}, dependencies: [ownedAssetsActionProvider]);

/// Owned private assets of the selection. The server only accepts unmarking while the session's
/// private mode is on, and private assets are only listed then anyway.
final _unmarkTargetsProvider = Provider.family.autoDispose<List<String>, ActionSource>((ref, source) {
  if (!ref.watch(isPrivateModeProvider) || ref.watch(inLockedViewProvider)) {
    return const [];
  }

  return ref.watch(ownedAssetsActionProvider(source)).private().map((asset) => asset.id).toList();
}, dependencies: [ownedAssetsActionProvider]);

class MarkPrivateAction extends AssetActionBuilder {
  const MarkPrivateAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    if (ref.watch(_markTargetsProvider(source).select((ids) => ids.isEmpty))) {
      return null;
    }

    return .new(icon: Icons.lock_person_outlined, label: context.t.mark_private, onAction: () => _mark(context, ref));
  }

  Future<void> _mark(BuildContext context, WidgetRef ref) async {
    final assetIds = ref.read(_markTargetsProvider(source));
    if (assetIds.isEmpty) {
      return;
    }

    final assetService = ref.read(assetServiceProvider);
    final albumService = ref.read(remoteAlbumServiceProvider);
    final toastService = ref.read(toastServiceProvider);
    final clearSelection = ref.read(clearSelectionProvider(source));
    // Removing the private flag again needs private mode, so the undo is only offered while it is on.
    // With the mode off the local rows flip to private and the filtered queries drop them right away.
    final canUndo = ref.read(isPrivateModeProvider);
    final message = context.t.marked_private(count: assetIds.length);

    try {
      // A private asset makes every album it is in private, and those albums are hidden while the
      // mode is off. Say so first, and offer to take the assets out of the albums instead.
      final albums = await albumService.getAlbumsContainingAssets(
        assetIds,
        privateFilter: ref.read(privateModeFilterProvider),
      );
      final publicAlbums = albums.where((album) => !album.isPrivate).toList();
      if (publicAlbums.isNotEmpty) {
        if (!context.mounted) {
          return;
        }
        final choice = await showPrivateAlbumsDialog(context, publicAlbums);
        if (choice == null) {
          return;
        }
        if (choice == PrivateAlbumsChoice.remove) {
          for (final album in publicAlbums) {
            await albumService.removeAssets(albumId: album.id, assetIds: assetIds);
          }
        }
      }

      await assetService.update(assetIds, isPrivate: const .some(true));
      final toast = canUndo
          ? ToastOption(onUndo: () => assetService.update(assetIds, isPrivate: const .some(false)))
          : null;
      toastService.success(message, toast: toast);
      clearSelection();
    } catch (error, stack) {
      handleError(error, stack: stack, description: "Failed to mark assets as private");
    }
  }
}

class UnmarkPrivateAction extends AssetActionBuilder {
  const UnmarkPrivateAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    if (ref.watch(_unmarkTargetsProvider(source).select((ids) => ids.isEmpty))) {
      return null;
    }

    return .new(icon: Icons.lock_open_rounded, label: context.t.unmark_private, onAction: () => _unmark(context, ref));
  }

  Future<void> _unmark(BuildContext context, WidgetRef ref) async {
    final assetIds = ref.read(_unmarkTargetsProvider(source));
    if (assetIds.isEmpty) {
      return;
    }

    final assetService = ref.read(assetServiceProvider);
    final toastService = ref.read(toastServiceProvider);
    final clearSelection = ref.read(clearSelectionProvider(source));
    final message = context.t.unmarked_private(count: assetIds.length);

    try {
      await assetService.update(assetIds, isPrivate: const .some(false));
      toastService.success(
        message,
        toast: ToastOption(onUndo: () => assetService.update(assetIds, isPrivate: const .some(true))),
      );
      clearSelection();
    } catch (error, stack) {
      handleError(error, stack: stack, description: "Failed to remove the private flag from assets");
    }
  }
}
