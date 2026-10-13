import {
  AssetMediaStatus,
  AssetUploadAction,
  deleteAssets,
  DeletedReimportMode,
  getAlbumInfo,
  getAllAlbums,
  getAssetInfo,
  getMyDeletedChecksumStatistics,
  getMyPreferences,
  getNotifications,
  LoginResponseDto,
  updateMyPreferences,
} from '@immich/sdk';
import { createHash } from 'node:crypto';
import { Socket } from 'socket.io-client';
import { makeRandomImage } from 'src/generators';
import { app, asBearerAuth, utils } from 'src/utils';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sha1 = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');

describe('/users/me/deleted-checksums', () => {
  let admin: LoginResponseDto;
  let ws: Socket;

  const permanentlyDelete = async (bytes: Buffer) => {
    const { id } = await utils.createAsset(admin.accessToken, { assetData: { bytes, filename: 'photo.png' } });
    await deleteAssets(
      { assetBulkDeleteDto: { ids: [id], force: true } },
      { headers: asBearerAuth(admin.accessToken) },
    );
    await utils.waitForWebsocketEvent({ event: 'assetDelete', id });
    return id;
  };

  const setMode = async (mode: DeletedReimportMode) => {
    const preferences = await updateMyPreferences(
      { userPreferencesUpdateDto: { deletedReimport: { mode } } },
      { headers: asBearerAuth(admin.accessToken) },
    );
    expect(preferences.deletedReimport.mode).toBe(mode);
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    ws = await utils.connectWebsocket(admin.accessToken);
  });

  afterAll(() => {
    utils.disconnectWebsocket(ws);
  });

  describe('GET /users/me/deleted-checksums/statistics', () => {
    it('should require authentication', async () => {
      const { status } = await request(app).get('/users/me/deleted-checksums/statistics');
      expect(status).toBe(401);
    });

    it('should count permanently deleted files but not trashed ones', async () => {
      await request(app)
        .delete('/users/me/deleted-checksums')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(204);

      const { id: trashed } = await utils.createAsset(admin.accessToken);
      await utils.deleteAssets(admin.accessToken, [trashed]);
      await permanentlyDelete(makeRandomImage());

      const { status, body } = await request(app)
        .get('/users/me/deleted-checksums/statistics')
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual({ count: 1 });
    });
  });

  describe('DELETE /users/me/deleted-checksums', () => {
    it('should require authentication', async () => {
      const { status } = await request(app).delete('/users/me/deleted-checksums');
      expect(status).toBe(401);
    });

    it('should forget every remembered file', async () => {
      await permanentlyDelete(makeRandomImage());

      const { status } = await request(app)
        .delete('/users/me/deleted-checksums')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(204);

      const statistics = await getMyDeletedChecksumStatistics({ headers: asBearerAuth(admin.accessToken) });
      expect(statistics).toEqual({ count: 0 });
    });
  });

  describe('re-uploading a previously deleted file', () => {
    it('should default to the trash mode', async () => {
      const { deletedReimport } = await getMyPreferences({ headers: asBearerAuth(admin.accessToken) });
      expect(deletedReimport).toEqual({ mode: DeletedReimportMode.Trash, albumId: null });
    });

    it('should store the upload in the trash and forget it once restored', async () => {
      await setMode(DeletedReimportMode.Trash);
      const bytes = makeRandomImage();
      await permanentlyDelete(bytes);

      const { id, status } = await utils.createAsset(admin.accessToken, { assetData: { bytes, filename: 'a.png' } });
      expect(status).toBe(AssetMediaStatus.Created);

      const asset = await getAssetInfo({ id }, { headers: asBearerAuth(admin.accessToken) });
      expect(asset.isTrashed).toBe(true);

      const { count: before } = await getMyDeletedChecksumStatistics({ headers: asBearerAuth(admin.accessToken) });
      await request(app)
        .post('/trash/restore/assets')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ids: [id] })
        .expect(200);
      const { count: after } = await getMyDeletedChecksumStatistics({ headers: asBearerAuth(admin.accessToken) });
      expect(after).toBe(before - 1);

      const restored = await getAssetInfo({ id }, { headers: asBearerAuth(admin.accessToken) });
      expect(restored.isTrashed).toBe(false);
    });

    it('should not store the upload in skip mode and reject it in the bulk upload check', async () => {
      await setMode(DeletedReimportMode.Skip);
      const bytes = makeRandomImage();
      const deletedId = await permanentlyDelete(bytes);

      const { body: check } = await request(app)
        .post('/assets/bulk-upload-check')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ assets: [{ id: 'file', checksum: sha1(bytes) }] })
        .expect(200);
      expect(check.results).toEqual([
        expect.objectContaining({ id: 'file', action: AssetUploadAction.Reject, assetId: deletedId }),
      ]);

      const { id, status } = await utils.createAsset(admin.accessToken, { assetData: { bytes, filename: 'a.png' } });
      expect(status).toBe(AssetMediaStatus.Duplicate);
      expect(id).toBe(deletedId);

      const { status: notFound } = await request(app)
        .get(`/assets/${id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(notFound).toBe(400);
    });

    it('should add the upload to the "Previously deleted" album in album mode', async () => {
      await setMode(DeletedReimportMode.Album);
      const bytes = makeRandomImage();
      await permanentlyDelete(bytes);

      const { id, status } = await utils.createAsset(admin.accessToken, { assetData: { bytes, filename: 'a.png' } });
      expect(status).toBe(AssetMediaStatus.Created);

      const { deletedReimport } = await getMyPreferences({ headers: asBearerAuth(admin.accessToken) });
      expect(deletedReimport.albumId).toEqual(expect.any(String));

      const albums = await getAllAlbums({}, { headers: asBearerAuth(admin.accessToken) });
      expect(albums).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: deletedReimport.albumId, albumName: 'Previously deleted' }),
        ]),
      );

      const album = await getAlbumInfo({ id: deletedReimport.albumId! }, { headers: asBearerAuth(admin.accessToken) });
      expect(album.assetCount).toBe(1);

      const asset = await getAssetInfo({ id }, { headers: asBearerAuth(admin.accessToken) });
      expect(asset.isTrashed).toBe(false);

      const { count: before } = await getMyDeletedChecksumStatistics({ headers: asBearerAuth(admin.accessToken) });
      await request(app)
        .delete(`/albums/${deletedReimport.albumId}/assets`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ids: [id] })
        .expect(200);
      const { count: after } = await getMyDeletedChecksumStatistics({ headers: asBearerAuth(admin.accessToken) });
      expect(after).toBe(before - 1);
    });

    it('should tell the user about the re-uploads with one notification', async () => {
      // the notification job is debounced for a few minutes, so only its creation can be verified here
      const notifications = await getNotifications({}, { headers: asBearerAuth(admin.accessToken) });
      expect(notifications.filter(({ title }) => title === 'Previously deleted files').length).toBeLessThanOrEqual(1);
    });
  });
});
