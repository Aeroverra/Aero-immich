import 'package:drift/drift.dart' hide isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/custom_view.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/tags_api.repository.dart';
import 'package:immich_mobile/providers/custom_view.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/private_mode.provider.dart';
import 'package:immich_mobile/providers/tagging.provider.dart';
import 'package:immich_mobile/repositories/custom_view_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart' hide ViewAccess;

class _MockTagsApiRepository extends Mock implements TagsApiRepository {}

class _MockCustomViewApiRepository extends Mock implements CustomViewApiRepository {}

class _TestPrivateModeNotifier extends PrivateModeNotifier {
  _TestPrivateModeNotifier(super.ref);

  void set(bool enabled) => state = enabled;

  @override
  Future<void> refresh() async {}
}

const _me = 'user-1';

TagEntry _tag(String id, {String? parentId, bool isHidden = false}) => TagEntry(
  id: id,
  ownerId: _me,
  value: parentId == null ? id : '$parentId/$id',
  parentId: parentId,
  isHidden: isHidden,
);

TagResponseDto _dto(String id, String value, {String? parentId, bool isHidden = false}) => TagResponseDto(
  id: id,
  name: value.split('/').last,
  value: value,
  parentId: parentId == null ? const Optional.absent() : Optional.present(parentId),
  isHidden: isHidden,
  createdAt: DateTime(2024),
  updatedAt: DateTime(2024),
);

void main() {
  late Drift db;
  late _MockTagsApiRepository api;
  late _MockCustomViewApiRepository viewApi;
  late TaggingService service;
  var invalidations = 0;

  setUpAll(() async {
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: StoreRepository(db));
  });

  tearDownAll(() async {
    await db.close();
  });

  setUp(() async {
    await db.tagEntity.deleteAll();
    await db.tagAssetEntity.deleteAll();
    await db.viewEntity.deleteAll();
    await db.viewTagEntity.deleteAll();
    api = _MockTagsApiRepository();
    viewApi = _MockCustomViewApiRepository();
    invalidations = 0;
    service = TaggingService(
      api: api,
      viewApi: viewApi,
      repository: db.customViewRepository,
      ownerId: () => _me,
      onTagsChanged: () => invalidations++,
    );
  });

  test('buildTagTree lists every parent before its children, siblings by name', () {
    final tree = buildTagTree([
      _tag('b'),
      _tag('z', parentId: 'a'),
      _tag('a'),
      _tag('y', parentId: 'a'),
      _tag('x', parentId: 'y'),
      // a parent this client does not have makes the tag a root
      _tag('orphan', parentId: 'missing'),
    ]);

    expect(tree.map((entry) => '${entry.tag.id}:${entry.depth}'), ['a:0', 'y:1', 'x:2', 'z:1', 'b:0', 'orphan:0']);
  });

  test('adding and removing a tag changes the server and the local links', () async {
    await db.customViewRepository.upsertTag(_tag('travel'));
    when(() => api.tagAssets('travel', any())).thenAnswer((invocation) async => invocation.positionalArguments[1]);
    when(() => api.untagAssets('travel', any())).thenAnswer((invocation) async => invocation.positionalArguments[1]);

    await service.addTag('travel', ['a', 'b']);
    expect(await service.countTagged(['a', 'b', 'c']), {'travel': 2});
    expect(service.recentTagIds.first, 'travel');

    await service.removeTag('travel', ['a']);
    expect(await service.countTagged(['a', 'b', 'c']), {'travel': 1});
    verify(() => api.tagAssets('travel', ['a', 'b'])).called(1);
    verify(() => api.untagAssets('travel', ['a'])).called(1);
  });

  test('creating a nested tag stores the tag and its parents', () async {
    when(
      () => api.upsertTags(['Gym/Progress']),
    ).thenAnswer((_) async => [_dto('gym', 'Gym'), _dto('progress', 'Gym/Progress', parentId: 'gym')]);

    final tag = await service.createTag(' Gym / Progress ');

    expect(tag.id, 'progress');
    final tags = await db.customViewRepository.getTags(_me);
    expect({for (final tag in tags) tag.id: tag.parentId}, {'gym': null, 'progress': 'gym'});
    expect(invalidations, 1);
  });

  test('hiding and deleting a tag follow the server', () async {
    await db.customViewRepository.upsertTag(_tag('gym'));
    await db.customViewRepository.upsertTag(_tag('progress', parentId: 'gym'));
    await db.customViewRepository.addTagAssets(['progress'], ['a']);
    when(() => api.updateTag('gym', isHidden: true)).thenAnswer((_) async => _dto('gym', 'gym', isHidden: true));
    when(() => api.deleteTag('gym')).thenAnswer((_) async {});

    await service.setHidden(_tag('gym'), true);
    expect((await db.customViewRepository.getTags(_me)).firstWhere((tag) => tag.id == 'gym').isHidden, isTrue);

    await service.deleteTag('gym');
    expect(await db.customViewRepository.getTags(_me), isEmpty);
    expect(await service.countTagged(['a']), isEmpty);
  });

  test('hidden tags and their children are left out while private mode is locked', () async {
    final container = ProviderContainer(
      overrides: [
        localTagsProvider.overrideWith(
          (ref) => Stream.value([_tag('hidden', isHidden: true), _tag('child', parentId: 'hidden'), _tag('open')]),
        ),
        privateModeProvider.overrideWith(_TestPrivateModeNotifier.new),
        driftProvider.overrideWithValue(db),
      ],
    );
    addTearDown(container.dispose);
    await db.customViewRepository.upsertTag(_tag('hidden', isHidden: true));
    await db.customViewRepository.upsertTag(_tag('child', parentId: 'hidden'));
    await db.customViewRepository.upsertTag(_tag('open'));
    await db.customViewRepository.addTagAssets(['child', 'open'], ['asset']);
    container.listen(tagTreeProvider, (_, _) {});
    container.listen(assetTagsProvider('asset'), (_, _) {});
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(container.read(tagTreeProvider).map((entry) => entry.tag.id), ['open']);
    expect((await container.read(assetTagsProvider('asset').future)).map((tag) => tag.id), ['open']);

    (container.read(privateModeProvider.notifier) as _TestPrivateModeNotifier).set(true);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(container.read(tagTreeProvider).map((entry) => entry.tag.id), ['hidden', 'child', 'open']);
    expect(
      (await container.read(assetTagsProvider('asset').future)).map((tag) => tag.id),
      unorderedEquals(['child', 'open']),
    );
  });
}
