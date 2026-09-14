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

/// The single dialog text a user acknowledges before assets go into an album, see [privateAddWarning]
class PrivateAddWarning {
  final String text;

  /// Local assets are about to be uploaded into a private album, so the dialog confirms an upload
  final bool upload;

  const PrivateAddWarning({required this.text, this.upload = false});
}

/// What the user has to acknowledge before [assets] go into [album], or null when nothing does: a
/// public album turns private and hidden while the mode is off once it holds a private asset, a
/// shared album shows private assets to everyone it is shared with, and device assets uploaded into
/// a private album come out private. Every applicable warning folds into one text.
/// The local album state only knows about album users; a link-only share is caught by the server,
/// whose refusal is recognised by [isPrivateConfirmationRequired].
PrivateAddWarning? privateAddWarning(BuildContext context, RemoteAlbum album, Iterable<BaseAsset> assets) {
  final hasPrivate = assets.whereType<RemoteAsset>().any((asset) => asset.isPrivate);
  final uploadsIntoPrivate = album.isPrivate && assets.whereType<LocalAsset>().any((asset) => asset.remoteId == null);
  if (!hasPrivate && !uploadsIntoPrivate) {
    return null;
  }

  final warnings = [
    if (uploadsIntoPrivate) context.t.upload_to_private_album_prompt(album: album.name),
    if (hasPrivate && !album.isPrivate) context.t.add_to_album_private_prompt(album: album.name),
    if (album.isShared) context.t.add_private_assets_to_shared_album_confirmation,
  ];
  return warnings.isEmpty ? null : PrivateAddWarning(text: warnings.join('\n\n'), upload: uploadsIntoPrivate);
}

/// The server's 400 for a share that touches private assets without `confirmPrivate: true`
bool isPrivateConfirmationRequired(Object error) =>
    error is ApiException && error.code == 400 && (error.message?.contains('confirmPrivate') ?? false);

/// Asks the user to acknowledge [warning] before assets are added to an album
Future<bool> confirmPrivateShare(BuildContext context, PrivateAddWarning warning) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (_) => ConfirmDialog(
      title: context.t.private,
      content: warning.text,
      ok: warning.upload ? context.t.upload_to_private_album_confirm : context.t.confirm,
    ),
  );
  return confirmed == true;
}

/// Runs [add] for an album, asking the user to acknowledge [warning] (see [privateAddWarning]) up
/// front when there is one and retrying with the acknowledgement when the server asks for it.
/// Returns null when the user declines, in which case nothing was added.
Future<T?> addWithPrivateShareConfirmation<T>(
  BuildContext context, {
  required PrivateAddWarning? warning,
  required Future<T> Function({required bool confirmPrivate}) add,
}) async {
  var confirmPrivate = false;
  if (warning != null) {
    confirmPrivate = await confirmPrivateShare(context, warning);
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

  if (!context.mounted ||
      !await confirmPrivateShare(
        context,
        PrivateAddWarning(text: context.t.add_private_assets_to_shared_album_confirmation),
      )) {
    return null;
  }
  return add(confirmPrivate: true);
}
