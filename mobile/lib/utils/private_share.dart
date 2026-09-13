import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:openapi/api.dart';

/// Sharing a private album with more people shows them its private assets. Asks first when the
/// album is private, then adds [userIds] with the acknowledgement. Returns false when nobody was added.
Future<bool> addUsersWithPrivateConfirmation(
  BuildContext context,
  WidgetRef ref,
  RemoteAlbum album,
  List<String> userIds,
) async {
  if (album.isPrivate) {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => ConfirmDialog(
        title: context.t.private,
        content: context.t.share_private_album_confirmation,
        ok: context.t.confirm,
      ),
    );
    if (confirmed != true) {
      return false;
    }
  }

  await ref.read(remoteAlbumProvider.notifier).addUsers(album.id, userIds, confirmPrivate: album.isPrivate);
  return true;
}

/// Adding a private asset to an album other people can see shares it with them, which the user
/// has to acknowledge first. The local album state only knows about album users; a link-only
/// share is caught by the server, whose refusal is recognised by [isPrivateConfirmationRequired].
bool needsPrivateShareConfirmation(RemoteAlbum album, Iterable<BaseAsset> assets) =>
    album.isShared && assets.whereType<RemoteAsset>().any((asset) => asset.isPrivate);

/// The server's 400 for a share that touches private assets without `confirmPrivate: true`
bool isPrivateConfirmationRequired(Object error) =>
    error is ApiException && error.code == 400 && (error.message?.contains('confirmPrivate') ?? false);

/// Asks the user to acknowledge that private assets become visible to everyone the album is shared with
Future<bool> confirmPrivateShare(BuildContext context) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (_) => ConfirmDialog(
      title: context.t.private,
      content: context.t.add_private_assets_to_shared_album_confirmation,
      ok: context.t.confirm,
    ),
  );
  return confirmed == true;
}

/// Runs [add] for an album, asking for the private share confirmation up front when the local
/// state already shows it is needed and retrying with it when the server asks for it. Returns
/// null when the user declines, in which case nothing was added.
Future<T?> addWithPrivateShareConfirmation<T>(
  BuildContext context, {
  required bool needsConfirmation,
  required Future<T> Function({required bool confirmPrivate}) add,
}) async {
  var confirmPrivate = false;
  if (needsConfirmation) {
    confirmPrivate = await confirmPrivateShare(context);
    if (!confirmPrivate) {
      return null;
    }
  }

  try {
    return await add(confirmPrivate: confirmPrivate);
  } catch (error) {
    if (confirmPrivate || !isPrivateConfirmationRequired(error)) {
      rethrow;
    }
  }

  if (!context.mounted || !await confirmPrivateShare(context)) {
    return null;
  }
  return add(confirmPrivate: true);
}
