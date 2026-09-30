import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/data/server/video_bookmark.dart';
import 'package:immich_mobile/domain/models/video_bookmark.model.dart';
import 'package:immich_mobile/providers/infrastructure/video_bookmark.provider.dart';
import 'package:mocktail/mocktail.dart';

class _MockVideoBookmarkApiRepository extends Mock implements VideoBookmarkApiRepository {}

const _asset = 'video-1';
const _kickoff = VideoBookmark(id: 'a', assetId: _asset, time: 12000, label: 'Kickoff');
const _ending = VideoBookmark(id: 'b', assetId: _asset, time: 131000, label: '');

void main() {
  late _MockVideoBookmarkApiRepository api;
  late ProviderContainer container;

  setUp(() {
    api = _MockVideoBookmarkApiRepository();
    container = ProviderContainer(overrides: [videoBookmarkApiRepositoryProvider.overrideWithValue(api)]);
  });

  // after stubbing: keeps the auto-dispose provider alive for the rest of the test and waits for the first load
  Future<List<VideoBookmark>> load() {
    container.listen(videoBookmarksProvider(_asset), (_, _) {});
    return container.read(videoBookmarksProvider(_asset).future);
  }

  tearDown(() => container.dispose());

  test('loads the bookmarks of the video', () async {
    when(() => api.getAll(_asset)).thenAnswer((_) async => [_kickoff, _ending]);

    expect(await load(), [_kickoff, _ending]);
  });

  test('yields no bookmarks when loading fails', () async {
    when(() => api.getAll(_asset)).thenThrow(Exception('offline'));

    expect(await load(), isEmpty);
  });

  test('adds a bookmark in time order', () async {
    const middle = VideoBookmark(id: 'c', assetId: _asset, time: 70250, label: '');
    when(() => api.getAll(_asset)).thenAnswer((_) async => [_kickoff, _ending]);
    when(() => api.create(_asset, 70250)).thenAnswer((_) async => middle);
    await load();

    final added = await container
        .read(videoBookmarksProvider(_asset).notifier)
        .add(const Duration(seconds: 70, milliseconds: 250));

    expect(added, middle);
    expect(container.read(videoBookmarksProvider(_asset)).value, [_kickoff, middle, _ending]);
  });

  test('keeps the list when the server refuses a bookmark', () async {
    when(() => api.getAll(_asset)).thenAnswer((_) async => [_kickoff]);
    when(() => api.create(any(), any())).thenThrow(Exception('400'));
    await load();

    final added = await container.read(videoBookmarksProvider(_asset).notifier).add(const Duration(seconds: 1));

    expect(added, isNull);
    expect(container.read(videoBookmarksProvider(_asset)).value, [_kickoff]);
  });

  test('edits only what changed, name trimmed', () async {
    when(() => api.getAll(_asset)).thenAnswer((_) async => [_kickoff, _ending]);
    when(
      () => api.update('b', time: null, label: 'Credits'),
    ).thenAnswer((_) async => _ending.copyWith(label: 'Credits'));
    await load();
    final notifier = container.read(videoBookmarksProvider(_asset).notifier);

    expect(await notifier.edit('a', time: 12000, label: ' Kickoff '), isTrue);
    expect(await notifier.edit('b', time: 131000, label: ' Credits '), isTrue);

    verifyNever(
      () => api.update(
        'a',
        time: any(named: 'time'),
        label: any(named: 'label'),
      ),
    );
    expect(container.read(videoBookmarksProvider(_asset)).value, [_kickoff, _ending.copyWith(label: 'Credits')]);
  });

  test('moves a bookmark and keeps the list in time order', () async {
    when(() => api.getAll(_asset)).thenAnswer((_) async => [_kickoff, _ending]);
    when(() => api.update('a', time: 140000, label: null)).thenAnswer((_) async => _kickoff.copyWith(time: 140000));
    await load();

    expect(await container.read(videoBookmarksProvider(_asset).notifier).edit('a', time: 140000), isTrue);

    expect(container.read(videoBookmarksProvider(_asset)).value, [_ending, _kickoff.copyWith(time: 140000)]);
  });

  test('removes a bookmark', () async {
    when(() => api.getAll(_asset)).thenAnswer((_) async => [_kickoff, _ending]);
    when(() => api.delete('a')).thenAnswer((_) async {});
    await load();

    expect(await container.read(videoBookmarksProvider(_asset).notifier).remove('a'), isTrue);

    expect(container.read(videoBookmarksProvider(_asset)).value, [_ending]);
  });
}
