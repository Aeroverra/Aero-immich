import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/routes.provider.dart';
import 'package:immich_mobile/utils/error_handler.dart';

typedef _State = ({bool shouldMarkPrivate, List<String> assetIds});

/// The server only accepts isPrivate changes while the session's private mode is on, so the
/// action stays hidden otherwise. Inside the private folder every asset is private already,
/// so only "remove from private" is offered there; outside it only "mark as private".
final _stateProvider = Provider.family.autoDispose<_State?, ActionSource>((ref, source) {
  if (!ref.watch(isPrivateModeProvider) || ref.watch(inLockedViewProvider)) {
    return null;
  }

  final assets = ref.watch(ownedAssetsActionProvider(source));
  if (assets.isEmpty) {
    return null;
  }

  final shouldMarkPrivate = !ref.watch(inPrivateViewProvider) && assets.private(isPrivate: false).isNotEmpty;
  final assetIds = assets.private(isPrivate: !shouldMarkPrivate).map((asset) => asset.id).toList(growable: false);
  return assetIds.isEmpty ? null : (shouldMarkPrivate: shouldMarkPrivate, assetIds: assetIds);
}, dependencies: [ownedAssetsActionProvider]);

class PrivateAction extends AssetActionBuilder {
  const PrivateAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    final shouldMarkPrivate = ref.watch(_stateProvider(source).select((state) => state?.shouldMarkPrivate));
    if (shouldMarkPrivate == null) {
      return null;
    }

    return .new(
      icon: shouldMarkPrivate ? Icons.lock_person_outlined : Icons.lock_open_rounded,
      label: shouldMarkPrivate ? context.t.mark_private : context.t.unmark_private,
      onAction: () => _setPrivate(context, ref),
    );
  }

  Future<void> _setPrivate(BuildContext context, WidgetRef ref) async {
    final state = ref.read(_stateProvider(source));
    if (state == null) {
      return;
    }

    final (:shouldMarkPrivate, :assetIds) = state;
    final message = shouldMarkPrivate ? context.t.mark_private : context.t.unmark_private;
    final assetService = ref.read(assetServiceProvider);
    final toastService = ref.read(toastServiceProvider);
    final clearSelection = ref.read(clearSelectionProvider(source));

    try {
      await assetService.update(assetIds, isPrivate: .some(shouldMarkPrivate));
      Future<void> undo() => assetService.update(assetIds, isPrivate: .some(!shouldMarkPrivate));
      toastService.success(message, toast: .new(onUndo: undo));
      clearSelection();
    } catch (error, stack) {
      handleError(error, stack: stack, description: "Failed to update the private status for assets");
    }
  }
}
