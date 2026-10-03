import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/server_capability.model.dart';
import 'package:immich_mobile/domain/models/sync_event.model.dart';
import 'package:immich_mobile/infrastructure/repositories/network.repository.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:immich_mobile/utils/semver.dart';
import 'package:logging/logging.dart';
import 'package:openapi/api.dart';

class SyncApiRepository {
  final Logger _logger = Logger('SyncApiRepository');
  final ApiService _api;
  SyncApiRepository(this._api);

  Future<void> ack(List<String> data) {
    return _api.syncApi.sendSyncAck(SyncAckSetDto(acks: data));
  }

  Future<void> deleteSyncAck(List<SyncEntityType> types) {
    return _api.syncApi.deleteSyncAck(SyncAckDeleteDto(types: Optional.present(types)));
  }

  Future<void> streamChanges(
    Future<void> Function(List<SyncEvent>, Function() abort, Function() reset) onData, {
    required SemVer serverVersion,
    bool supportsStackSource = false,
    bool supportsCustomViews = false,
    Function()? onReset,
    int batchSize = kSyncEventBatchSize,
    http.Client? httpClient,
    Future<void>? abortSignal,
  }) async {
    final stopwatch = Stopwatch()..start();
    final client = httpClient ?? NetworkRepository.client;
    final endpoint = "${_api.apiClient.basePath}/sync/stream";

    final headers = {'Content-Type': 'application/json', 'Accept': 'application/jsonlines+json'};

    final request = http.AbortableRequest('POST', Uri.parse(endpoint), abortTrigger: abortSignal);
    request.headers.addAll(headers);
    request.body = jsonEncode(
      SyncStreamDto(
        types: [
          SyncRequestType.authUsersV1,
          SyncRequestType.usersV1,
          serverVersion.supports(.syncV2) ? SyncRequestType.assetsV2 : SyncRequestType.assetsV1,
          SyncRequestType.assetExifsV1,
          if (serverVersion.supports(.assetEdits)) SyncRequestType.assetEditsV1,
          SyncRequestType.assetMetadataV1,
          SyncRequestType.partnersV1,
          serverVersion.supports(.syncV2) ? SyncRequestType.partnerAssetsV2 : SyncRequestType.partnerAssetsV1,
          SyncRequestType.partnerAssetExifsV1,
          serverVersion.supports(.syncV2) ? SyncRequestType.albumsV2 : SyncRequestType.albumsV1,
          SyncRequestType.albumUsersV1,
          serverVersion.supports(.syncV2) ? SyncRequestType.albumAssetsV2 : SyncRequestType.albumAssetsV1,
          SyncRequestType.albumAssetExifsV1,
          SyncRequestType.albumToAssetsV1,
          SyncRequestType.memoriesV1,
          SyncRequestType.memoryToAssetsV1,
          supportsStackSource ? SyncRequestType.stacksV2 : SyncRequestType.stacksV1,
          supportsStackSource ? SyncRequestType.partnerStacksV2 : SyncRequestType.partnerStacksV1,
          SyncRequestType.userMetadataV1,
          SyncRequestType.peopleV1,
          serverVersion.supports(.assetFacesV2) ? SyncRequestType.assetFacesV2 : SyncRequestType.assetFacesV1,
          if (serverVersion.supports(.assetOcr)) SyncRequestType.assetOcrV1,
          if (supportsCustomViews) ...[
            SyncRequestType.tagsV1,
            SyncRequestType.tagAssetsV1,
            SyncRequestType.viewsV1,
            SyncRequestType.viewTagsV1,
          ],
        ],
        // this build understands private assets; without the flag the server withholds them
        includePrivate: const Optional.present(true),
        // this build applies custom views locally; without the flag the server only sends the default view
        includeViews: supportsCustomViews ? const Optional.present(true) : const Optional.absent(),
      ).toJson(),
    );

    String previousChunk = '';
    final List<String> lines = [];

    bool shouldAbort = false;

    void abort() {
      _logger.warning("Abort requested, stopping sync stream");
      shouldAbort = true;
    }

    final reset = onReset ?? () {};

    try {
      final response = await client.send(request);

      if (response.statusCode != 200) {
        final errorBody = await response.stream.bytesToString();
        throw ApiException(response.statusCode, 'Failed to get sync stream: $errorBody');
      }

      await for (final chunk in response.stream.transform(utf8.decoder)) {
        if (shouldAbort) {
          break;
        }

        previousChunk += chunk;
        final parts = previousChunk.split('\n');
        previousChunk = parts.removeLast();
        lines.addAll(parts);

        if (lines.length < batchSize) {
          continue;
        }

        await onData(_parseLines(lines), abort, reset);
        lines.clear();
      }

      if (lines.isNotEmpty && !shouldAbort) {
        await onData(_parseLines(lines), abort, reset);
      }
    } catch (error, stack) {
      return Future.error(error, stack);
    }
    stopwatch.stop();
    _logger.info("Remote Sync completed in ${stopwatch.elapsed.inMilliseconds}ms");
  }

  List<SyncEvent> _parseLines(List<String> lines) {
    final List<SyncEvent> data = [];

    for (final line in lines) {
      final jsonData = jsonDecode(line);
      final type = SyncEntityType.fromJson(jsonData['type'])!;
      final dataJson = jsonData['data'];
      final ack = jsonData['ack'];
      final converter = _kResponseMap[type];
      if (converter == null) {
        _logger.warning("Unknown type $type");
        continue;
      }

      data.add(SyncEvent(type: type, data: converter(dataJson), ack: ack));
    }

    return data;
  }
}

const _kResponseMap = <SyncEntityType, Function(Object)>{
  SyncEntityType.authUserV1: SyncAuthUserV1.fromJson,
  SyncEntityType.userV1: SyncUserV1.fromJson,
  SyncEntityType.userDeleteV1: SyncUserDeleteV1.fromJson,
  SyncEntityType.partnerV1: SyncPartnerV1.fromJson,
  SyncEntityType.partnerDeleteV1: SyncPartnerDeleteV1.fromJson,
  SyncEntityType.assetV1: SyncAssetV1.fromJson,
  SyncEntityType.assetV2: SyncAssetV2.fromJson,
  SyncEntityType.assetDeleteV1: SyncAssetDeleteV1.fromJson,
  SyncEntityType.assetExifV1: SyncAssetExifV1.fromJson,
  SyncEntityType.assetEditV1: SyncAssetEditV1.fromJson,
  SyncEntityType.assetEditDeleteV1: SyncAssetEditDeleteV1.fromJson,
  SyncEntityType.assetMetadataV1: SyncAssetMetadataV1.fromJson,
  SyncEntityType.assetMetadataDeleteV1: SyncAssetMetadataDeleteV1.fromJson,
  SyncEntityType.partnerAssetV1: SyncAssetV1.fromJson,
  SyncEntityType.partnerAssetV2: SyncAssetV2.fromJson,
  SyncEntityType.partnerAssetBackfillV1: SyncAssetV1.fromJson,
  SyncEntityType.partnerAssetBackfillV2: SyncAssetV2.fromJson,
  SyncEntityType.partnerAssetDeleteV1: SyncAssetDeleteV1.fromJson,
  SyncEntityType.partnerAssetExifV1: SyncAssetExifV1.fromJson,
  SyncEntityType.partnerAssetExifBackfillV1: SyncAssetExifV1.fromJson,
  SyncEntityType.albumV1: SyncAlbumV1.fromJson,
  SyncEntityType.albumV2: SyncAlbumV2.fromJson,
  SyncEntityType.albumDeleteV1: SyncAlbumDeleteV1.fromJson,
  SyncEntityType.albumUserV1: SyncAlbumUserV1.fromJson,
  SyncEntityType.albumUserBackfillV1: SyncAlbumUserV1.fromJson,
  SyncEntityType.albumUserDeleteV1: SyncAlbumUserDeleteV1.fromJson,
  SyncEntityType.albumAssetCreateV1: SyncAssetV1.fromJson,
  SyncEntityType.albumAssetCreateV2: SyncAssetV2.fromJson,
  SyncEntityType.albumAssetUpdateV1: SyncAssetV1.fromJson,
  SyncEntityType.albumAssetUpdateV2: SyncAssetV2.fromJson,
  SyncEntityType.albumAssetBackfillV1: SyncAssetV1.fromJson,
  SyncEntityType.albumAssetBackfillV2: SyncAssetV2.fromJson,
  SyncEntityType.albumAssetExifCreateV1: SyncAssetExifV1.fromJson,
  SyncEntityType.albumAssetExifUpdateV1: SyncAssetExifV1.fromJson,
  SyncEntityType.albumAssetExifBackfillV1: SyncAssetExifV1.fromJson,
  SyncEntityType.albumToAssetV1: SyncAlbumToAssetV1.fromJson,
  SyncEntityType.albumToAssetBackfillV1: SyncAlbumToAssetV1.fromJson,
  SyncEntityType.albumToAssetDeleteV1: SyncAlbumToAssetDeleteV1.fromJson,
  SyncEntityType.syncAckV1: _SyncEmptyDto.fromJson,
  SyncEntityType.syncResetV1: _SyncEmptyDto.fromJson,
  SyncEntityType.memoryV1: SyncMemoryV1.fromJson,
  SyncEntityType.memoryDeleteV1: SyncMemoryDeleteV1.fromJson,
  SyncEntityType.memoryToAssetV1: SyncMemoryAssetV1.fromJson,
  SyncEntityType.memoryToAssetDeleteV1: SyncMemoryAssetDeleteV1.fromJson,
  SyncEntityType.stackV1: SyncStackV1.fromJson,
  SyncEntityType.stackV2: SyncStackV2.fromJson,
  SyncEntityType.stackDeleteV1: SyncStackDeleteV1.fromJson,
  SyncEntityType.partnerStackV1: SyncStackV1.fromJson,
  SyncEntityType.partnerStackV2: SyncStackV2.fromJson,
  SyncEntityType.partnerStackBackfillV1: SyncStackV1.fromJson,
  SyncEntityType.partnerStackBackfillV2: SyncStackV2.fromJson,
  SyncEntityType.partnerStackDeleteV1: SyncStackDeleteV1.fromJson,
  SyncEntityType.tagV1: SyncTagV1.fromJson,
  SyncEntityType.tagDeleteV1: SyncTagDeleteV1.fromJson,
  SyncEntityType.tagAssetV1: SyncTagAssetV1.fromJson,
  SyncEntityType.tagAssetDeleteV1: SyncTagAssetDeleteV1.fromJson,
  SyncEntityType.viewV1: SyncViewV1.fromJson,
  SyncEntityType.viewDeleteV1: SyncViewDeleteV1.fromJson,
  SyncEntityType.viewTagV1: SyncViewTagV1.fromJson,
  SyncEntityType.viewTagDeleteV1: SyncViewTagDeleteV1.fromJson,
  SyncEntityType.userMetadataV1: SyncUserMetadataV1.fromJson,
  SyncEntityType.userMetadataDeleteV1: SyncUserMetadataDeleteV1.fromJson,
  SyncEntityType.personV1: SyncPersonV1.fromJson,
  SyncEntityType.personDeleteV1: SyncPersonDeleteV1.fromJson,
  SyncEntityType.assetFaceV1: SyncAssetFaceV1.fromJson,
  SyncEntityType.assetFaceV2: SyncAssetFaceV2.fromJson,
  SyncEntityType.assetFaceDeleteV1: SyncAssetFaceDeleteV1.fromJson,
  SyncEntityType.assetOcrV1: SyncAssetOcrV1.fromJson,
  SyncEntityType.assetOcrDeleteV1: SyncAssetOcrDeleteV1.fromJson,
  SyncEntityType.syncCompleteV1: _SyncEmptyDto.fromJson,
};

class _SyncEmptyDto {
  static _SyncEmptyDto? fromJson(dynamic _) => _SyncEmptyDto();
}
