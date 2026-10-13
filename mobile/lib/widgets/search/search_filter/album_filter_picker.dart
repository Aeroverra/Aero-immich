import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/widgets/common/search_field.dart';

/// Picks the albums a search looks in and the albums it leaves out, one list at a time. The user's own and shared
/// albums are listed. An album is in one list at most: picking it in the other list moves it there.
class AlbumFilterPicker extends HookConsumerWidget {
  final Set<String> initialIncluded;
  final Set<String> initialExcluded;
  final void Function(Set<String> includedIds, Set<String> excludedIds) onChanged;

  const AlbumFilterPicker({
    super.key,
    required this.initialIncluded,
    required this.initialExcluded,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final excludeMode = useState(false);
    final included = useState<Set<String>>(initialIncluded);
    final excluded = useState<Set<String>>(initialExcluded);
    final query = useState('');
    final formFocus = useFocusNode();
    final albums = ref.watch(remoteAlbumProvider.select((state) => state.albums));
    final userId = ref.watch(currentUserProvider.select((user) => user?.id));

    // the album list is only kept fresh while the albums tab is used
    useEffect(() {
      unawaited(ref.read(remoteAlbumProvider.notifier).refresh());
      return null;
    }, const []);

    void toggle(String albumId) {
      final picked = excludeMode.value ? excluded : included;
      final other = excludeMode.value ? included : excluded;
      picked.value = picked.value.contains(albumId) ? picked.value.difference({albumId}) : {...picked.value, albumId};
      other.value = other.value.difference({albumId});
      onChanged(included.value, excluded.value);
    }

    final lowerQuery = query.value.trim().toLowerCase();
    final shown = albums.where((album) => album.name.toLowerCase().contains(lowerQuery)).toList()
      ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    final selection = excludeMode.value ? excluded.value : included.value;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8),
          child: SegmentedButton<bool>(
            key: const Key('album-filter-mode'),
            segments: [
              ButtonSegment(
                value: false,
                label: Text(context.t.search_include_albums),
                icon: const Icon(Icons.photo_album_outlined),
              ),
              ButtonSegment(
                value: true,
                label: Text(context.t.search_exclude_albums),
                icon: const Icon(Icons.remove_circle_outline_rounded),
              ),
            ],
            selected: {excludeMode.value},
            onSelectionChanged: (selection) => excludeMode.value = selection.first,
          ),
        ),
        Padding(
          padding: const EdgeInsets.all(8),
          child: SearchField(
            key: const Key('album-filter-search'),
            focusNode: formFocus,
            onChanged: (value) => query.value = value,
            onTapOutside: (_) => formFocus.unfocus(),
            filled: true,
            hintText: context.t.search_albums,
          ),
        ),
        Expanded(
          child: shown.isEmpty
              ? Center(
                  child: Text(
                    context.t.no_albums_found,
                    style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                  ),
                )
              : ListView.builder(
                  itemCount: shown.length,
                  padding: const EdgeInsets.all(8),
                  itemBuilder: (context, index) {
                    final album = shown[index];
                    final isSelected = selection.contains(album.id);
                    return ListTile(
                      key: Key('album-filter-${album.id}'),
                      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(10))),
                      selected: isSelected,
                      selectedTileColor: context.primaryColor.withAlpha(25),
                      title: Text(album.name),
                      subtitle: album.ownerId != userId ? Text(context.t.shared_by_user(user: album.ownerName)) : null,
                      trailing: isSelected
                          ? Icon(excludeMode.value ? Icons.remove_circle_outline_rounded : Icons.check_rounded)
                          : null,
                      onTap: () => toggle(album.id),
                    );
                  },
                ),
        ),
      ],
    );
  }
}
