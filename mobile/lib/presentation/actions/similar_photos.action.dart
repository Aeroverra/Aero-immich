import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/routing/router.dart';

class SimilarPhotosAction extends ActionBuilder {
  final String assetId;

  const SimilarPhotosAction({required this.assetId});

  @override
  ActionItem create(BuildContext context, WidgetRef ref) =>
      .new(icon: Icons.compare, label: context.t.view_similar_photos, onAction: () => _search(context, ref));

  Future<void> _search(BuildContext context, WidgetRef ref) async {
    // Push the results above the viewer instead of switching the tab shell to the Search tab. The tab switch closed
    // the viewer and the page it was opened from, so the system back had nothing to return to and left the app.
    // With a pushed page, back lands on this photo, and the Search tab keeps whatever the user had searched.
    final router = context.router;
    final viewer = ref.read(assetViewerProvider.notifier);
    final asset = ref.read(assetViewerProvider).currentAsset;
    final thumbnailSize = ref.read(assetViewerProvider).thumbnailSize;

    await router.push(SimilarPhotosRoute(assetId: assetId));

    // Opening a result shares the viewer state with this viewer, so point it back at the photo the search started
    // from before it is on screen again.
    if (asset != null) {
      viewer
        ..reset()
        ..setAsset(asset, thumbnailSize: thumbnailSize);
    }
  }
}
