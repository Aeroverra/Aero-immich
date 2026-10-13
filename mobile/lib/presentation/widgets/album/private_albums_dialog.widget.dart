import 'package:flutter/material.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';

enum PrivateAlbumsChoice {
  /// Mark private and let the albums turn private with the assets
  keep,

  /// Take the assets out of the albums first so the albums stay visible
  remove,
}

/// Warns that [albums] turn private (hidden while private mode is off) once the selected assets are
/// marked private. Returns null when the user cancels.
Future<PrivateAlbumsChoice?> showPrivateAlbumsDialog(BuildContext context, List<RemoteAlbum> albums) async {
  var choice = PrivateAlbumsChoice.keep;
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (_) => PrivateAlbumsDialog(albums: albums, onChoiceChanged: (value) => choice = value),
  );
  return confirmed == true ? choice : null;
}

class PrivateAlbumsDialog extends StatefulWidget {
  final List<RemoteAlbum> albums;
  final ValueChanged<PrivateAlbumsChoice> onChoiceChanged;

  const PrivateAlbumsDialog({super.key, required this.albums, required this.onChoiceChanged});

  @override
  State<PrivateAlbumsDialog> createState() => _PrivateAlbumsDialogState();
}

class _PrivateAlbumsDialogState extends State<PrivateAlbumsDialog> {
  bool _removeFromAlbums = false;

  @override
  Widget build(BuildContext context) {
    return ConfirmDialog(
      title: context.t.mark_private_albums_title,
      content: context.t.mark_private_albums_description(count: widget.albums.length),
      ok: context.t.mark_private_keep_albums,
      body: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final album in widget.albums)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      album.name,
                      overflow: TextOverflow.ellipsis,
                      style: context.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                    ),
                  ),
                  if (album.isShared) ...[
                    Icon(Icons.share_outlined, size: 16, color: context.colorScheme.onSurfaceSecondary),
                    const SizedBox(width: 4),
                    Text(
                      context.t.shared,
                      style: context.textTheme.labelSmall?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                    ),
                  ],
                ],
              ),
            ),
          const SizedBox(height: 8),
          CheckboxListTile(
            value: _removeFromAlbums,
            onChanged: (value) {
              setState(() => _removeFromAlbums = value ?? false);
              widget.onChoiceChanged(_removeFromAlbums ? PrivateAlbumsChoice.remove : PrivateAlbumsChoice.keep);
            },
            controlAffinity: ListTileControlAffinity.leading,
            contentPadding: EdgeInsets.zero,
            dense: true,
            title: Text(context.t.mark_private_remove_from_albums, style: context.textTheme.bodyMedium),
          ),
        ],
      ),
    );
  }
}
