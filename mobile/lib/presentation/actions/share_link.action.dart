import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/utils/stack_selection.dart';

final _stateProvider = Provider.family.autoDispose<List<String>?, ActionSource>((ref, source) {
  final assets = ref.watch(assetsActionProvider(source));
  final remoteIds = assets.remote().map((asset) => asset.id).toList(growable: false);
  return remoteIds.isEmpty ? null : remoteIds;
}, dependencies: [assetsActionProvider]);

class ShareLinkAction extends AssetActionBuilder {
  const ShareLinkAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    final remoteIds = ref.watch(_stateProvider(source));
    if (remoteIds == null) {
      return null;
    }

    return .new(icon: Icons.link_rounded, label: context.t.share_link, onAction: () => _share(context, ref, remoteIds));
  }

  Future<void> _share(BuildContext context, WidgetRef ref, List<String> remoteIds) async {
    final selected = ref.read(assetsActionProvider(source)).remote().where((asset) => remoteIds.contains(asset.id));
    final stacked = await resolveStackedAssets(context, ref, source, selected);
    if (stacked == null || !context.mounted) {
      return;
    }

    unawaited(context.pushRoute(SharedLinkEditRoute(assetsList: [...remoteIds, ...stacked.map((asset) => asset.id)])));
  }
}
