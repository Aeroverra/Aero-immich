import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/models/private_mode.model.dart';
import 'package:immich_mobile/domain/services/asset.service.dart';
import 'package:immich_mobile/domain/services/hidden_asset.service.dart';
import 'package:immich_mobile/infrastructure/repositories/custom_view.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/remote_asset.repository.dart';

import '../../infrastructure/repository.mock.dart';
import '../../repository.mocks.dart';
import '../repository_context.dart';

/// The user's own setup: Default hides private assets and everything tagged Unreviewed, three private-mode views
void main() {
  late MediumRepositoryContext ctx;
  late CustomViewRepository views;
  late HiddenAssetService sut;
  late String me;

  late CustomView defaultView;
  late CustomView unreviewed;
  late CustomView all;
  late CustomView privateOnly;
  late CustomView gym;

  setUp(() async {
    ctx = MediumRepositoryContext();
    views = CustomViewRepository(ctx.db);
    sut = HiddenAssetService(
      AssetService(
        remoteRepository: RemoteAssetRepository(ctx.db),
        exifRepository: MockRemoteExifRepository(),
        localRepository: MockLocalAssetRepository(),
        apiRepository: MockAssetApiRepository(),
        mediaRepository: MockAssetMediaRepository(),
        trashedLocalRepository: MockTrashedLocalAssetRepository(),
      ),
    );
    me = (await ctx.newUser()).id;

    await views.upsertTag(TagEntry(id: 'Unreviewed', ownerId: me, value: 'Unreviewed'));
    await views.upsertTag(TagEntry(id: 'Gym', ownerId: me, value: 'Gym'));
    Future<void> asset(String id, {List<String> tags = const [], bool isPrivate = false}) async {
      await ctx.newRemoteAsset(id: id, ownerId: me, isPrivate: isPrivate);
      await views.addTagAssets(tags, [id]);
    }

    await asset('normal');
    await asset('private', isPrivate: true);
    await asset('unreviewed', tags: ['Unreviewed']);
    await asset('gym', tags: ['Gym']);

    defaultView = CustomView(
      id: 'default',
      ownerId: me,
      name: 'Default',
      isDefault: true,
      excludeTagIds: const ['Unreviewed', 'Gym'],
      privateAssets: ViewPrivateAssets.hide,
    );
    unreviewed = CustomView(
      id: 'unreviewed-view',
      ownerId: me,
      name: 'Unreviewed',
      access: ViewAccess.private,
      includeAll: false,
      includeTagIds: const ['Unreviewed'],
    );
    all = CustomView(id: 'all', ownerId: me, name: 'All', access: ViewAccess.private);
    privateOnly = CustomView(
      id: 'private-only',
      ownerId: me,
      name: 'Private Only',
      access: ViewAccess.private,
      privateAssets: ViewPrivateAssets.only,
    );
    gym = CustomView(
      id: 'gym-view',
      ownerId: me,
      name: 'Gym',
      access: ViewAccess.locked,
      includeAll: false,
      includeTagIds: const ['Gym'],
    );
  });

  tearDown(() async {
    await ctx.dispose();
  });

  Future<HiddenAssetOptions> options(String assetId, {required bool privateMode, CustomView? applied}) async {
    final allViews = [defaultView, unreviewed, all, privateOnly, gym];
    final tags = await views.getTags(me);
    final appliedView = applied ?? defaultView;
    return sut.getOptions(
      assetId,
      HiddenAssetContext(
        filter: PrivateModeFilter(enabled: privateMode, userId: me, view: ViewFilter.fromView(appliedView, tags)),
        appliedView: appliedView,
        switchableViews: allViews.where((view) => view.access != ViewAccess.private || privateMode).toList(),
        allViews: allViews,
        tags: tags,
      ),
    );
  }

  List<String> names(HiddenAssetOptions options) => options.views.map((view) => view.name).toList();

  test('an asset the default view shows needs nothing', () async {
    final result = await options('normal', privateMode: false);

    expect(result.visible, isTrue);
  });

  test('a private asset offers nothing while private mode is off, so the page asks for the PIN', () async {
    final result = await options('private', privateMode: false);

    expect(result.visible, isFalse);
    expect(result.hasViews, isFalse);
  });

  test('a private asset lists the private views that show it once private mode is on', () async {
    final result = await options('private', privateMode: true);

    expect(result.visible, isFalse);
    expect(names(result), ['All', 'Private Only']);
  });

  test('an asset only private views show asks for the PIN first, then lists them', () async {
    expect((await options('unreviewed', privateMode: false)).hasViews, isFalse);
    expect(names(await options('unreviewed', privateMode: true)), ['Unreviewed', 'All']);
  });

  test('a locked view is offered without private mode', () async {
    expect(names(await options('gym', privateMode: false)), ['Gym']);
  });

  test('a view that already shows the asset needs nothing', () async {
    final result = await options('private', privateMode: true, applied: all);

    expect(result.visible, isTrue);
  });

  test('a missing asset offers nothing', () async {
    final result = await options('missing', privateMode: true);

    expect(result.visible, isFalse);
    expect(result.hasViews, isFalse);
  });
}
