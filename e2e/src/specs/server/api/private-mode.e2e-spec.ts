import {
  AlbumResponseDto,
  AlbumUserRole,
  AssetMediaResponseDto,
  AssetVisibility,
  LoginResponseDto,
  MemoryType,
  Permission,
  ReactionType,
  SharedLinkType,
  addAssetsToAlbum,
  createActivity,
  createMemory,
  disablePrivateMode,
  enablePrivateMode,
  getActivities,
  getActivityStatistics,
  getAlbumInfo,
  getAlbumStatistics,
  getAllPeople,
  getAssetDuplicates,
  getAssetInfo,
  getAssetStatistics,
  getAssetsByOriginalPath,
  getAuthStatus,
  getDownloadInfo,
  getMapMarkers,
  getMyPreferences,
  getMySharedLink,
  getTimeBucket,
  getTimeBuckets,
  getUniqueOriginalPaths,
  removeAssetFromAlbum,
  searchAssetStatistics,
  searchMemories,
  searchRandom,
  searchStacks,
  setupPinCode,
  updateAsset,
  updateAssets,
  updatePartner,
} from '@immich/sdk';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Socket } from 'socket.io-client';
import { createUserDto } from 'src/fixtures';
import { errorDto } from 'src/responses';
import { app, asBearerAuth, testAssetDir, utils } from 'src/utils';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const pinCode = '123456';
const bucketDate = '2020-06-15T12:00:00.000Z';
const bucketPrefix = '2020-06';

const asAuth = (accessToken: string) => ({ headers: asBearerAuth(accessToken) });
const authHeader = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });
const enable = (accessToken: string) => enablePrivateMode({ sessionUnlockDto: { pinCode } }, asAuth(accessToken));
const disable = (accessToken: string) => disablePrivateMode(asAuth(accessToken));
const markPrivate = (accessToken: string, id: string) =>
  updateAsset({ id, updateAssetDto: { isPrivate: true } }, asAuth(accessToken));
const findBucket = async (accessToken: string, query: Parameters<typeof getTimeBuckets>[0] = {}) => {
  const buckets = await getTimeBuckets(query, asAuth(accessToken));
  return buckets.find(({ timeBucket }) => timeBucket.startsWith(bucketPrefix));
};
// album contents are served by the timeline, not by GET /albums/:id
const albumAssetIds = async (albumId: string, viewer: { accessToken?: string; key?: string }) => {
  const opts = viewer.accessToken ? asAuth(viewer.accessToken) : {};
  const buckets = await getTimeBuckets({ albumId, key: viewer.key }, opts);
  const ids: string[] = [];
  for (const { timeBucket } of buckets) {
    const bucket = await getTimeBucket({ albumId, timeBucket, key: viewer.key }, opts);
    ids.push(...bucket.id);
  }
  return ids;
};

describe('private mode', () => {
  let admin: LoginResponseDto;
  let user1: LoginResponseDto;
  let user2: LoginResponseDto;
  let counter: LoginResponseDto;
  let websocket: Socket;
  let plainAsset: AssetMediaResponseDto;
  let privateAsset: AssetMediaResponseDto;
  let counterPlainAsset: AssetMediaResponseDto;
  let counterPrivateAsset: AssetMediaResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();

    [user1, user2, counter] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
      utils.userSetup(admin.accessToken, createUserDto.user3),
    ]);

    await Promise.all([
      setupPinCode({ pinCodeSetupDto: { pinCode } }, asAuth(user1.accessToken)),
      setupPinCode({ pinCodeSetupDto: { pinCode } }, asAuth(user2.accessToken)),
      setupPinCode({ pinCodeSetupDto: { pinCode } }, asAuth(counter.accessToken)),
    ]);

    websocket = await utils.connectWebsocket(user1.accessToken);

    // user1 accumulates assets across the suite, so tests on it assert with contains / not contains
    [plainAsset, privateAsset] = await Promise.all([
      utils.createAsset(user1.accessToken, { fileCreatedAt: bucketDate }),
      utils.createAsset(user1.accessToken, { fileCreatedAt: bucketDate }),
    ]);

    // counter owns exactly one plain and one private asset, so tests on it assert exact totals
    [counterPlainAsset, counterPrivateAsset] = await Promise.all([
      utils.createAsset(counter.accessToken, { fileCreatedAt: bucketDate }),
      utils.createAsset(counter.accessToken, { fileCreatedAt: bucketDate }),
    ]);

    await utils.waitForWebsocketEvent({ event: 'assetUpload', id: privateAsset.id });
    await utils.waitForWebsocketEvent({ event: 'assetUpload', id: plainAsset.id });

    await enable(user1.accessToken);
    await markPrivate(user1.accessToken, privateAsset.id);
    await disable(user1.accessToken);

    await enable(counter.accessToken);
    await markPrivate(counter.accessToken, counterPrivateAsset.id);
    await disable(counter.accessToken);
  });

  afterEach(async () => {
    await Promise.all([disable(user1.accessToken), disable(user2.accessToken), disable(counter.accessToken)]);
  });

  afterAll(() => {
    utils.disconnectWebsocket(websocket);
  });

  describe('POST /auth/session/private-mode', () => {
    it('should report the mode off by default', async () => {
      const status = await getAuthStatus(asAuth(user1.accessToken));
      expect(status.pinCode).toBe(true);
      expect(status.privateMode).toBe(false);
      expect(status.privateModeExpiresAt).toBeUndefined();
    });

    it('should enable, report and disable the mode for the session', async () => {
      const { status } = await request(app)
        .post('/auth/session/private-mode')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ pinCode });
      expect(status).toBe(204);

      const enabled = await getAuthStatus(asAuth(user1.accessToken));
      expect(enabled.privateMode).toBe(true);
      expect(enabled.privateModeExpiresAt).toEqual(expect.any(String));
      expect(new Date(enabled.privateModeExpiresAt as string).getTime()).toBeGreaterThan(Date.now());

      const { status: disableStatus } = await request(app)
        .delete('/auth/session/private-mode')
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(disableStatus).toBe(204);

      const disabled = await getAuthStatus(asAuth(user1.accessToken));
      expect(disabled.privateMode).toBe(false);
      expect(disabled.privateModeExpiresAt).toBeUndefined();
    });

    it('should only affect the session that enabled it', async () => {
      const otherSession = await utils.userSetup(admin.accessToken, createUserDto.create('other-session'));
      await setupPinCode({ pinCodeSetupDto: { pinCode } }, asAuth(otherSession.accessToken));
      const secondSession = await request(app)
        .post('/auth/login')
        .send({
          email: createUserDto.create('other-session').email,
          password: createUserDto.create('other-session').password,
        });
      expect(secondSession.status).toBe(201);

      await enable(otherSession.accessToken);

      const first = await getAuthStatus(asAuth(otherSession.accessToken));
      const second = await getAuthStatus(asAuth(secondSession.body.accessToken));
      expect(first.privateMode).toBe(true);
      expect(second.privateMode).toBe(false);

      await disable(otherSession.accessToken);
    });

    it('should reject a wrong PIN', async () => {
      const { status, body } = await request(app)
        .post('/auth/session/private-mode')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ pinCode: '000000' });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Wrong PIN code'));

      const authStatus = await getAuthStatus(asAuth(user1.accessToken));
      expect(authStatus.privateMode).toBe(false);
    });

    it('should reject a user without a PIN', async () => {
      const { status, body } = await request(app)
        .post('/auth/session/private-mode')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ pinCode });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('User does not have a PIN code'));
    });

    it('should reject an API key', async () => {
      const { secret } = await utils.createApiKey(user1.accessToken, [Permission.All]);

      const { status, body } = await request(app)
        .post('/auth/session/private-mode')
        .set('x-api-key', secret)
        .send({ pinCode });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('This endpoint can only be used with a session token'));

      const { status: disableStatus } = await request(app)
        .delete('/auth/session/private-mode')
        .set('x-api-key', secret);
      expect(disableStatus).toBe(400);
    });
  });

  describe('PUT /users/me/preferences (privateMode.timeoutMinutes)', () => {
    it('should default to 30 minutes', async () => {
      const preferences = await getMyPreferences(asAuth(user2.accessToken));
      expect(preferences.privateMode).toEqual({ timeoutMinutes: 30 });
    });

    it('should round trip a valid timeout and apply it to the next enable', async () => {
      const updated = await utils.updateMyPreferences(user2.accessToken, { privateMode: { timeoutMinutes: 1 } });
      expect(updated.privateMode).toEqual({ timeoutMinutes: 1 });

      const preferences = await getMyPreferences(asAuth(user2.accessToken));
      expect(preferences.privateMode).toEqual({ timeoutMinutes: 1 });

      await enable(user2.accessToken);
      const status = await getAuthStatus(asAuth(user2.accessToken));
      expect(status.privateMode).toBe(true);
      const remainingMs = new Date(status.privateModeExpiresAt as string).getTime() - Date.now();
      expect(remainingMs).toBeGreaterThan(0);
      expect(remainingMs).toBeLessThanOrEqual(2 * 60 * 1000);
      await disable(user2.accessToken);

      const reset = await utils.updateMyPreferences(user2.accessToken, { privateMode: { timeoutMinutes: 30 } });
      expect(reset.privateMode).toEqual({ timeoutMinutes: 30 });
    });

    it('should reject 0 minutes', async () => {
      const { status } = await request(app)
        .put('/users/me/preferences')
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({ privateMode: { timeoutMinutes: 0 } });
      expect(status).toBe(400);
    });

    it('should reject 1441 minutes', async () => {
      const { status } = await request(app)
        .put('/users/me/preferences')
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({ privateMode: { timeoutMinutes: 1441 } });
      expect(status).toBe(400);

      const preferences = await getMyPreferences(asAuth(user2.accessToken));
      expect(preferences.privateMode).toEqual({ timeoutMinutes: 30 });
    });
  });

  describe('PUT /assets/:id (isPrivate)', () => {
    it('should mark an asset private without the mode and hide it from the session', async () => {
      const asset = await utils.createAsset(user1.accessToken, { fileCreatedAt: bucketDate });
      await utils.waitForWebsocketEvent({ event: 'assetUpload', id: asset.id });
      const before = await findBucket(user1.accessToken);
      const visible = await getTimeBucket({ timeBucket: before!.timeBucket }, asAuth(user1.accessToken));
      expect(visible.id).toContain(asset.id);

      const { status, body } = await request(app)
        .put(`/assets/${asset.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ isPrivate: true });
      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ id: asset.id, isPrivate: true }));

      // the asset vanishes from this session until the mode is on
      const hidden = await request(app).get(`/assets/${asset.id}`).set('Authorization', `Bearer ${user1.accessToken}`);
      expect(hidden.status).toBe(400);
      const after = await findBucket(user1.accessToken);
      expect(after!.count).toBe(before!.count - 1);
      const bucket = await getTimeBucket({ timeBucket: after!.timeBucket }, asAuth(user1.accessToken));
      expect(bucket.id).not.toContain(asset.id);

      await enable(user1.accessToken);
      const info = await getAssetInfo({ id: asset.id }, asAuth(user1.accessToken));
      expect(info.isPrivate).toBe(true);
    });

    it('should bulk mark assets private without the mode', async () => {
      const [asset1, asset2] = await Promise.all([
        utils.createAsset(user1.accessToken),
        utils.createAsset(user1.accessToken),
      ]);

      const { status } = await request(app)
        .put('/assets')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ ids: [asset1.id, asset2.id], isPrivate: true });
      expect(status).toBe(204);

      for (const { id } of [asset1, asset2]) {
        const hidden = await request(app).get(`/assets/${id}`).set('Authorization', `Bearer ${user1.accessToken}`);
        expect(hidden.status).toBe(400);
      }

      await enable(user1.accessToken);
      const [info1, info2] = await Promise.all([
        getAssetInfo({ id: asset1.id }, asAuth(user1.accessToken)),
        getAssetInfo({ id: asset2.id }, asAuth(user1.accessToken)),
      ]);
      expect(info1.isPrivate).toBe(true);
      expect(info2.isPrivate).toBe(true);
    });

    it('should require the mode to unmark an asset private', async () => {
      const asset = await utils.createAsset(user1.accessToken);
      await markPrivate(user1.accessToken, asset.id);

      const { status } = await request(app)
        .put(`/assets/${asset.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ isPrivate: false });
      expect(status).toBe(400);

      const bulk = await request(app)
        .put('/assets')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ ids: [asset.id], isPrivate: false });
      expect(bulk.status).toBe(400);

      await enable(user1.accessToken);
      const unmarked = await updateAsset(
        { id: asset.id, updateAssetDto: { isPrivate: false } },
        asAuth(user1.accessToken),
      );
      expect(unmarked.isPrivate).toBe(false);
    });

    it('should mark and unmark an asset private with the mode on', async () => {
      const asset = await utils.createAsset(user1.accessToken);
      await enable(user1.accessToken);

      const { status, body } = await request(app)
        .put(`/assets/${asset.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ isPrivate: true });
      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ id: asset.id, isPrivate: true }));

      const unmarked = await updateAsset(
        { id: asset.id, updateAssetDto: { isPrivate: false } },
        asAuth(user1.accessToken),
      );
      expect(unmarked.isPrivate).toBe(false);
    });

    it('should bulk mark assets private with the mode on', async () => {
      const [asset1, asset2] = await Promise.all([
        utils.createAsset(user1.accessToken),
        utils.createAsset(user1.accessToken),
      ]);
      await enable(user1.accessToken);

      await updateAssets(
        { assetBulkUpdateDto: { ids: [asset1.id, asset2.id], isPrivate: true } },
        asAuth(user1.accessToken),
      );

      const [info1, info2] = await Promise.all([
        getAssetInfo({ id: asset1.id }, asAuth(user1.accessToken)),
        getAssetInfo({ id: asset2.id }, asAuth(user1.accessToken)),
      ]);
      expect(info1.isPrivate).toBe(true);
      expect(info2.isPrivate).toBe(true);
    });
  });

  describe('GET /assets/:id', () => {
    it('should hide a private asset with the mode off', async () => {
      const { status, body } = await request(app)
        .get(`/assets/${privateAsset.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Not found or no asset.read access'));
    });

    it('should return a private asset with the mode on', async () => {
      await enable(user1.accessToken);
      const { status, body } = await request(app)
        .get(`/assets/${privateAsset.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ id: privateAsset.id, isPrivate: true }));
    });

    it('should hide the thumbnail with the mode off', async () => {
      const { status } = await request(app)
        .get(`/assets/${privateAsset.id}/thumbnail`)
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(400);
    });

    it('should serve the thumbnail with the mode on', async () => {
      await enable(user1.accessToken);
      const { status, type } = await request(app)
        .get(`/assets/${privateAsset.id}/thumbnail`)
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(type).toContain('image/');
    });

    it('should hide the original with the mode off', async () => {
      // the original route answers 404 for an unknown asset, and a hidden private asset behaves the same way
      const { status } = await request(app)
        .get(`/assets/${privateAsset.id}/original`)
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(404);
    });

    it('should serve the original with the mode on', async () => {
      await enable(user1.accessToken);
      const { status, type } = await request(app)
        .get(`/assets/${privateAsset.id}/original`)
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(200);
      expect(type).toBe('image/png');
    });
  });

  describe('GET /timeline/buckets', () => {
    it('should exclude private assets from bucket counts with the mode off', async () => {
      const bucket = await findBucket(counter.accessToken);
      expect(bucket).toEqual({ timeBucket: expect.any(String), count: 1 });
    });

    it('should include private assets in bucket counts with the mode on', async () => {
      await enable(counter.accessToken);
      const bucket = await findBucket(counter.accessToken);
      expect(bucket).toEqual({ timeBucket: expect.any(String), count: 2 });
    });

    it('should exclude private assets from the bucket with the mode off', async () => {
      const bucket = await findBucket(counter.accessToken);
      const assets = await getTimeBucket({ timeBucket: bucket!.timeBucket }, asAuth(counter.accessToken));
      expect(assets.id).toEqual([counterPlainAsset.id]);
      expect(assets.isPrivate).toEqual([false]);
    });

    it('should include private assets in the bucket with the mode on', async () => {
      await enable(counter.accessToken);
      const bucket = await findBucket(counter.accessToken);
      const assets = await getTimeBucket({ timeBucket: bucket!.timeBucket }, asAuth(counter.accessToken));
      expect(assets.id).toHaveLength(2);
      expect(assets.id).toEqual(expect.arrayContaining([counterPlainAsset.id, counterPrivateAsset.id]));
      expect(assets.isPrivate[assets.id.indexOf(counterPrivateAsset.id)]).toBe(true);
      expect(assets.isPrivate[assets.id.indexOf(counterPlainAsset.id)]).toBe(false);
    });

    it('should require the mode for isPrivate=true', async () => {
      const { status } = await request(app)
        .get('/timeline/buckets')
        .query({ isPrivate: true })
        .set('Authorization', `Bearer ${counter.accessToken}`);
      expect(status).toBe(401);

      const bucketResponse = await request(app)
        .get('/timeline/bucket')
        .query({ isPrivate: true, timeBucket: '2020-06-01T00:00:00.000Z' })
        .set('Authorization', `Bearer ${counter.accessToken}`);
      expect(bucketResponse.status).toBe(401);
    });

    it('should return only private assets for isPrivate=true with the mode on', async () => {
      await enable(counter.accessToken);
      const bucket = await findBucket(counter.accessToken, { isPrivate: true });
      expect(bucket).toEqual({ timeBucket: expect.any(String), count: 1 });

      const assets = await getTimeBucket(
        { timeBucket: bucket!.timeBucket, isPrivate: true },
        asAuth(counter.accessToken),
      );
      expect(assets.id).toEqual([counterPrivateAsset.id]);
      expect(assets.isPrivate).toEqual([true]);
    });

    it('should reject withPartners together with isPrivate', async () => {
      await enable(counter.accessToken);
      const { status, body } = await request(app)
        .get('/timeline/buckets')
        .query({ isPrivate: true, withPartners: true })
        .set('Authorization', `Bearer ${counter.accessToken}`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('withPartners is not supported for private assets'));
    });
  });

  describe('GET /assets/statistics', () => {
    it('should exclude private assets with the mode off', async () => {
      const stats = await getAssetStatistics({}, asAuth(counter.accessToken));
      expect(stats).toEqual({ images: 1, videos: 0, total: 1 });
    });

    it('should include private assets with the mode on', async () => {
      await enable(counter.accessToken);
      const stats = await getAssetStatistics({}, asAuth(counter.accessToken));
      expect(stats).toEqual({ images: 2, videos: 0, total: 2 });
    });

    it('should require the mode for isPrivate=true', async () => {
      const { status } = await request(app)
        .get('/assets/statistics')
        .query({ isPrivate: true })
        .set('Authorization', `Bearer ${counter.accessToken}`);
      expect(status).toBe(401);
    });

    it('should count only private assets for isPrivate=true with the mode on', async () => {
      await enable(counter.accessToken);
      const stats = await getAssetStatistics({ isPrivate: true }, asAuth(counter.accessToken));
      expect(stats).toEqual({ images: 1, videos: 0, total: 1 });
    });
  });

  describe('POST /search', () => {
    it('should exclude private assets from metadata search with the mode off', async () => {
      const { assets } = await utils.searchAssets(counter.accessToken, {});
      expect(assets.items.map(({ id }) => id)).toEqual([counterPlainAsset.id]);
    });

    it('should include private assets in metadata search with the mode on', async () => {
      await enable(counter.accessToken);
      const { assets } = await utils.searchAssets(counter.accessToken, {});
      expect(assets.items).toHaveLength(2);
      expect(assets.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: counterPlainAsset.id, isPrivate: false }),
          expect.objectContaining({ id: counterPrivateAsset.id, isPrivate: true }),
        ]),
      );
    });

    it('should exclude private assets from random search with the mode off', async () => {
      const assets = await searchRandom({ randomSearchDto: { size: 10 } }, asAuth(counter.accessToken));
      expect(assets.map(({ id }) => id)).toEqual([counterPlainAsset.id]);
    });

    it('should include private assets in random search with the mode on', async () => {
      await enable(counter.accessToken);
      const assets = await searchRandom({ randomSearchDto: { size: 10 } }, asAuth(counter.accessToken));
      const ids = assets.map(({ id }) => id);
      expect(ids).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining([counterPlainAsset.id, counterPrivateAsset.id]));
    });

    it('should exclude private assets from search statistics with the mode off', async () => {
      const stats = await searchAssetStatistics({ statisticsSearchDto: {} }, asAuth(counter.accessToken));
      expect(stats).toEqual({ total: 1 });
    });

    it('should include private assets in search statistics with the mode on', async () => {
      await enable(counter.accessToken);
      const stats = await searchAssetStatistics({ statisticsSearchDto: {} }, asAuth(counter.accessToken));
      expect(stats).toEqual({ total: 2 });
    });
  });

  describe('GET /map/markers', () => {
    let privateLocationId: string;
    let plainLocationId: string;

    beforeAll(async () => {
      const upload = async (input: string) => {
        const filepath = join(testAssetDir, input);
        const { id } = await utils.createAsset(user1.accessToken, {
          assetData: { bytes: await readFile(filepath), filename: basename(filepath) },
        });
        await utils.waitForWebsocketEvent({ event: 'assetUpload', id });
        return id;
      };

      privateLocationId = await upload('metadata/gps-position/thompson-springs.jpg');
      plainLocationId = await upload('metadata/dates/datetimeoriginal-gps.jpg');

      await enable(user1.accessToken);
      await markPrivate(user1.accessToken, privateLocationId);
      await disable(user1.accessToken);
    });

    it('should exclude private assets with the mode off', async () => {
      const markers = await getMapMarkers({}, asAuth(user1.accessToken));
      const ids = markers.map(({ id }) => id);
      expect(ids).toContain(plainLocationId);
      expect(ids).not.toContain(privateLocationId);
    });

    it('should include private assets with the mode on', async () => {
      await enable(user1.accessToken);
      const markers = await getMapMarkers({}, asAuth(user1.accessToken));
      const ids = markers.map(({ id }) => id);
      expect(ids).toContain(plainLocationId);
      expect(ids).toContain(privateLocationId);
    });
  });

  describe('GET /memories', () => {
    let memoryId: string;

    beforeAll(async () => {
      await enable(user1.accessToken);
      const memory = await createMemory(
        {
          memoryCreateDto: {
            type: MemoryType.OnThisDay,
            data: { year: 2020 },
            memoryAt: bucketDate,
            assetIds: [privateAsset.id],
          },
        },
        asAuth(user1.accessToken),
      );
      memoryId = memory.id;
      expect(memory.assets.map(({ id }) => id)).toEqual([privateAsset.id]);
      await disable(user1.accessToken);
    });

    it('should hide a memory whose only asset is private with the mode off', async () => {
      const memories = await searchMemories({}, asAuth(user1.accessToken));
      expect(memories.map(({ id }) => id)).not.toContain(memoryId);
    });

    it('should list the memory and its private asset with the mode on', async () => {
      await enable(user1.accessToken);
      const memories = await searchMemories({}, asAuth(user1.accessToken));
      const memory = memories.find(({ id }) => id === memoryId);
      expect(memory).toBeDefined();
      expect(memory!.assets.map(({ id }) => id)).toEqual([privateAsset.id]);
    });
  });

  describe('GET /duplicates', () => {
    const duplicateId = randomUUID();
    let privateDuplicate: AssetMediaResponseDto;
    let plainDuplicate: AssetMediaResponseDto;

    beforeAll(async () => {
      [privateDuplicate, plainDuplicate] = await Promise.all([
        utils.createAsset(user1.accessToken),
        utils.createAsset(user1.accessToken),
      ]);
      await utils.setAssetDuplicateId(user1.accessToken, privateDuplicate.id, duplicateId);
      await utils.setAssetDuplicateId(user1.accessToken, plainDuplicate.id, duplicateId);

      await enable(user1.accessToken);
      await markPrivate(user1.accessToken, privateDuplicate.id);
      await disable(user1.accessToken);
    });

    it('should hide the group when its private member is hidden with the mode off', async () => {
      const duplicates = await getAssetDuplicates(asAuth(user1.accessToken));
      expect(duplicates.map((group) => group.duplicateId)).not.toContain(duplicateId);
    });

    it('should show the full group with the mode on', async () => {
      await enable(user1.accessToken);
      const duplicates = await getAssetDuplicates(asAuth(user1.accessToken));
      const group = duplicates.find((candidate) => candidate.duplicateId === duplicateId);
      expect(group).toBeDefined();
      const ids = group!.assets.map(({ id }) => id);
      expect(ids).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining([plainDuplicate.id, privateDuplicate.id]));
    });
  });

  describe('GET /stacks', () => {
    let stackId: string;
    let privatePrimary: AssetMediaResponseDto;
    let plainSecondary: AssetMediaResponseDto;

    beforeAll(async () => {
      [privatePrimary, plainSecondary] = await Promise.all([
        utils.createAsset(user1.accessToken),
        utils.createAsset(user1.accessToken),
      ]);

      await enable(user1.accessToken);
      await markPrivate(user1.accessToken, privatePrimary.id);
      const stack = await utils.createStack(user1.accessToken, [privatePrimary.id, plainSecondary.id]);
      stackId = stack.id;
      expect(stack.primaryAssetId).toBe(privatePrimary.id);
      await disable(user1.accessToken);
    });

    it('should omit a stack whose primary asset is private with the mode off', async () => {
      const stacks = await searchStacks({}, asAuth(user1.accessToken));
      expect(stacks.map(({ id }) => id)).not.toContain(stackId);

      const byPrimary = await searchStacks({ primaryAssetId: privatePrimary.id }, asAuth(user1.accessToken));
      expect(byPrimary).toEqual([]);
    });

    it('should list the stack with the mode on', async () => {
      await enable(user1.accessToken);
      const stacks = await searchStacks({ primaryAssetId: privatePrimary.id }, asAuth(user1.accessToken));
      expect(stacks).toEqual([
        expect.objectContaining({
          id: stackId,
          primaryAssetId: privatePrimary.id,
          assets: expect.arrayContaining([
            expect.objectContaining({ id: privatePrimary.id }),
            expect.objectContaining({ id: plainSecondary.id }),
          ]),
        }),
      ]);
      expect(stacks[0].assets).toHaveLength(2);
    });
  });

  describe('GET /view/folder', () => {
    let folder: string;

    beforeAll(async () => {
      await enable(user1.accessToken);
      const info = await getAssetInfo({ id: privateAsset.id }, asAuth(user1.accessToken));
      folder = dirname(info.originalPath);
      await disable(user1.accessToken);
    });

    it('should exclude private assets from the folder listing with the mode off', async () => {
      const assets = await getAssetsByOriginalPath({ path: folder }, asAuth(user1.accessToken));
      expect(assets.map(({ id }) => id)).not.toContain(privateAsset.id);
    });

    it('should include private assets in the folder listing with the mode on', async () => {
      await enable(user1.accessToken);
      const paths = await getUniqueOriginalPaths(asAuth(user1.accessToken));
      expect(paths).toContain(folder);

      const assets = await getAssetsByOriginalPath({ path: folder }, asAuth(user1.accessToken));
      expect(assets.map(({ id }) => id)).toContain(privateAsset.id);
    });
  });

  describe('GET /people', () => {
    let personId: string;

    beforeAll(async () => {
      const person = await utils.createPerson(user1.accessToken, { name: 'Private Only Person' });
      personId = person.id;
      await utils.createFace({ assetId: privateAsset.id, personGroupId: person.id });
    });

    it('should exclude a person seen only on private assets with the mode off', async () => {
      const { people, total } = await getAllPeople({}, asAuth(user1.accessToken));
      expect(people.map(({ id }) => id)).not.toContain(personId);
      expect(total).toBe(0);
    });

    it('should include the person with the mode on', async () => {
      await enable(user1.accessToken);
      const { people, total } = await getAllPeople({}, asAuth(user1.accessToken));
      expect(people.map(({ id }) => id)).toContain(personId);
      expect(total).toBe(1);
    });
  });

  describe('/download', () => {
    it('should exclude private assets from the user download info with the mode off', async () => {
      const info = await getDownloadInfo({ downloadInfoDto: { userId: counter.userId } }, asAuth(counter.accessToken));
      expect(info.archives.flatMap(({ assetIds }) => assetIds)).toEqual([counterPlainAsset.id]);
    });

    it('should include private assets in the user download info with the mode on', async () => {
      await enable(counter.accessToken);
      const info = await getDownloadInfo({ downloadInfoDto: { userId: counter.userId } }, asAuth(counter.accessToken));
      const ids = info.archives.flatMap(({ assetIds }) => assetIds);
      expect(ids).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining([counterPlainAsset.id, counterPrivateAsset.id]));
    });

    it('should refuse download info for a private asset id with the mode off', async () => {
      const { status, body } = await request(app)
        .post('/download/info')
        .set('Authorization', `Bearer ${counter.accessToken}`)
        .send({ assetIds: [counterPrivateAsset.id] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Not found or no asset.download access'));
    });

    it('should refuse the archive for a private asset id with the mode off', async () => {
      const { status } = await request(app)
        .post('/download/archive')
        .set('Authorization', `Bearer ${counter.accessToken}`)
        .send({ assetIds: [counterPrivateAsset.id] });
      expect(status).toBe(400);
    });

    it('should stream the archive for a private asset id with the mode on', async () => {
      await enable(counter.accessToken);
      const { status, type } = await request(app)
        .post('/download/archive')
        .set('Authorization', `Bearer ${counter.accessToken}`)
        .send({ assetIds: [counterPrivateAsset.id] });
      expect(status).toBe(200);
      expect(type).toBe('application/octet-stream');
    });
  });

  describe('/albums', () => {
    let album: AlbumResponseDto;
    let firstAsset: AssetMediaResponseDto;
    let secondAsset: AssetMediaResponseDto;

    beforeAll(async () => {
      firstAsset = await utils.createAsset(user1.accessToken);
      album = await utils.createAlbum(user1.accessToken, { albumName: 'private flag', assetIds: [firstAsset.id] });
      expect(album.isPrivate).toBe(false);
      expect(album.albumThumbnailAssetId).toBe(firstAsset.id);
    });

    it('should flip the album private when an asset in it is marked private', async () => {
      await enable(user1.accessToken);
      await markPrivate(user1.accessToken, firstAsset.id);

      const info = await getAlbumInfo({ id: album.id }, asAuth(user1.accessToken));
      expect(info.isPrivate).toBe(true);
    });

    it('should hide the private album as a whole with the mode off', async () => {
      const { status, body } = await request(app)
        .get(`/albums/${album.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Not found or no album.read access'));

      const list = await request(app).get('/albums').set('Authorization', `Bearer ${user1.accessToken}`);
      expect(list.status).toBe(200);
      expect(list.body).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: album.id })]));

      const byAsset = await request(app)
        .get('/albums')
        .query({ assetId: firstAsset.id })
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(byAsset.status).toBe(200);
      expect(byAsset.body).toEqual([]);

      const buckets = await request(app)
        .get('/timeline/buckets')
        .query({ albumId: album.id })
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(buckets.status).toBe(400);
      expect(buckets.body).toEqual(errorDto.badRequest('Not found or no album.read access'));
    });

    it('should leave the private album out of the album statistics with the mode off', async () => {
      const off = await getAlbumStatistics(asAuth(user1.accessToken));
      await enable(user1.accessToken);
      const on = await getAlbumStatistics(asAuth(user1.accessToken));
      expect(on.owned).toBe(off.owned + 1);
      expect(on.notShared).toBe(off.notShared + 1);
      expect(on.shared).toBe(off.shared);
    });

    it('should refuse to update, share or delete a hidden private album with the mode off', async () => {
      const auth = { Authorization: `Bearer ${user1.accessToken}` };
      const update = await request(app).patch(`/albums/${album.id}`).set(auth).send({ albumName: 'renamed' });
      expect(update.status).toBe(400);
      expect(update.body).toEqual(errorDto.badRequest('Not found or no album.update access'));

      const share = await request(app)
        .put(`/albums/${album.id}/users`)
        .set(auth)
        .send({ albumUsers: [{ userId: user2.userId, role: AlbumUserRole.Editor }], confirmPrivate: true });
      expect(share.status).toBe(400);
      expect(share.body).toEqual(errorDto.badRequest('Not found or no album.share access'));

      const remove = await request(app).delete(`/albums/${album.id}`).set(auth);
      expect(remove.status).toBe(400);
      expect(remove.body).toEqual(errorDto.badRequest('Not found or no album.delete access'));

      await enable(user1.accessToken);
      const info = await getAlbumInfo({ id: album.id }, asAuth(user1.accessToken));
      expect(info.albumName).toBe('private flag');
      expect(info.albumUsers).toHaveLength(1);
    });

    it('should show the private asset, its count and the cover with the mode on', async () => {
      await enable(user1.accessToken);
      const info = await getAlbumInfo({ id: album.id }, asAuth(user1.accessToken));
      expect(info.isPrivate).toBe(true);
      expect(info.assetCount).toBe(1);
      expect(info.albumThumbnailAssetId).toBe(firstAsset.id);
      await expect(albumAssetIds(album.id, user1)).resolves.toEqual([firstAsset.id]);
    });

    it('should refuse to add assets to a hidden private album with the mode off', async () => {
      secondAsset = await utils.createAsset(user1.accessToken);

      const { status, body } = await request(app)
        .put(`/albums/${album.id}/assets`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ ids: [secondAsset.id] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Not found or no albumAsset.create access'));

      const bulk = await request(app)
        .put('/albums/assets')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ albumIds: [album.id], assetIds: [secondAsset.id] });
      expect(bulk.status).toBe(200);
      expect(bulk.body).toEqual({ success: false, error: 'no_permission' });

      const info = await getAssetInfo({ id: secondAsset.id }, asAuth(user1.accessToken));
      expect(info.isPrivate).toBe(false);
    });

    it('should make a plain asset private when it is added to a private album', async () => {
      await enable(user1.accessToken);
      const results = await addAssetsToAlbum(
        { id: album.id, albumAddAssetsDto: { ids: [secondAsset.id] } },
        asAuth(user1.accessToken),
      );
      expect(results).toEqual([expect.objectContaining({ id: secondAsset.id, success: true })]);

      const info = await getAssetInfo({ id: secondAsset.id }, asAuth(user1.accessToken));
      expect(info.isPrivate).toBe(true);

      const albumInfo = await getAlbumInfo({ id: album.id }, asAuth(user1.accessToken));
      expect(albumInfo.assetCount).toBe(2);
    });

    it('should flip a plain album private when a private asset is added', async () => {
      const plainMember = await utils.createAsset(user1.accessToken);
      const other = await utils.createAlbum(user1.accessToken, { albumName: 'flips', assetIds: [plainMember.id] });
      expect(other.isPrivate).toBe(false);

      await enable(user1.accessToken);
      await addAssetsToAlbum(
        { id: other.id, albumAddAssetsDto: { ids: [privateAsset.id] } },
        asAuth(user1.accessToken),
      );

      const info = await getAlbumInfo({ id: other.id }, asAuth(user1.accessToken));
      expect(info.isPrivate).toBe(true);
      expect(info.assetCount).toBe(2);

      // existing members are left alone, only the album flag flips
      const member = await getAssetInfo({ id: plainMember.id }, asAuth(user1.accessToken));
      expect(member.isPrivate).toBe(false);

      // the whole album disappears from a session without the mode
      await disable(user1.accessToken);
      const hidden = await request(app).get(`/albums/${other.id}`).set('Authorization', `Bearer ${user1.accessToken}`);
      expect(hidden.status).toBe(400);
    });

    it('should clear the album flag when the last private asset is removed', async () => {
      await enable(user1.accessToken);
      await removeAssetFromAlbum({ id: album.id, bulkIdsDto: { ids: [firstAsset.id] } }, asAuth(user1.accessToken));

      const stillPrivate = await getAlbumInfo({ id: album.id }, asAuth(user1.accessToken));
      expect(stillPrivate.isPrivate).toBe(true);

      await removeAssetFromAlbum({ id: album.id, bulkIdsDto: { ids: [secondAsset.id] } }, asAuth(user1.accessToken));

      const cleared = await getAlbumInfo({ id: album.id }, asAuth(user1.accessToken));
      expect(cleared.isPrivate).toBe(false);
      expect(cleared.assetCount).toBe(0);
    });
  });

  describe('partners', () => {
    beforeAll(async () => {
      await utils.createPartner(user1.accessToken, user2.userId);
      // the partner id is the sharing user's id, and only the recipient can pin it to their timeline
      await updatePartner({ id: user1.userId, partnerUpdateDto: { inTimeline: true } }, asAuth(user2.accessToken));
    });

    it('should never show the partner private assets, even with the viewer mode on', async () => {
      await enable(user2.accessToken);

      const buckets = await getTimeBuckets({ userId: user1.userId }, asAuth(user2.accessToken));
      const bucket = buckets.find(({ timeBucket }) => timeBucket.startsWith(bucketPrefix));
      expect(bucket).toBeDefined();
      const assets = await getTimeBucket(
        { timeBucket: bucket!.timeBucket, userId: user1.userId },
        asAuth(user2.accessToken),
      );
      expect(assets.id).toContain(plainAsset.id);
      expect(assets.id).not.toContain(privateAsset.id);

      const withPartners = await getTimeBucket(
        { timeBucket: bucket!.timeBucket, withPartners: true, visibility: AssetVisibility.Timeline },
        asAuth(user2.accessToken),
      );
      expect(withPartners.id).toContain(plainAsset.id);
      expect(withPartners.id).not.toContain(privateAsset.id);

      const { status } = await request(app)
        .get(`/assets/${privateAsset.id}`)
        .set('Authorization', `Bearer ${user2.accessToken}`);
      expect(status).toBe(400);

      const markers = await getMapMarkers({ withPartners: true }, asAuth(user2.accessToken));
      expect(markers.map(({ id }) => id)).not.toContain(privateAsset.id);
    });

    it('should never show the partner private assets with the sharer mode on', async () => {
      await enable(user1.accessToken);
      const buckets = await getTimeBuckets({ userId: user1.userId }, asAuth(user2.accessToken));
      const bucket = buckets.find(({ timeBucket }) => timeBucket.startsWith(bucketPrefix));
      const assets = await getTimeBucket(
        { timeBucket: bucket!.timeBucket, userId: user1.userId },
        asAuth(user2.accessToken),
      );
      expect(assets.id).not.toContain(privateAsset.id);
    });
  });

  describe('shared albums', () => {
    let shared: AlbumResponseDto;

    beforeAll(async () => {
      await enable(user1.accessToken);
      shared = await utils.createAlbum(user1.accessToken, {
        albumName: 'shared private',
        assetIds: [plainAsset.id, privateAsset.id],
      });
      // the create response is mapped before the album_asset trigger runs, so re-read the flag
      shared = await getAlbumInfo({ id: shared.id }, asAuth(user1.accessToken));
      expect(shared.isPrivate).toBe(true);
      await disable(user1.accessToken);
    });

    it('should require confirmPrivate to share a private album', async () => {
      // a private album can only be shared from a session with the mode on, it is hidden otherwise
      await enable(user1.accessToken);
      const { status, body } = await request(app)
        .put(`/albums/${shared.id}/users`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ albumUsers: [{ userId: user2.userId, role: AlbumUserRole.Editor }] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Album contains private assets, confirmPrivate is required'));
    });

    it('should share a private album with confirmPrivate', async () => {
      await enable(user1.accessToken);
      const { status, body } = await request(app)
        .put(`/albums/${shared.id}/users`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ albumUsers: [{ userId: user2.userId, role: AlbumUserRole.Editor }], confirmPrivate: true });
      expect(status).toBe(200);
      expect(body.albumUsers).toEqual(
        expect.arrayContaining([expect.objectContaining({ user: expect.objectContaining({ id: user2.userId }) })]),
      );
    });

    it('should hide the shared private album from a co-viewer whose own mode is off', async () => {
      const { status, body } = await request(app)
        .get(`/albums/${shared.id}`)
        .set('Authorization', `Bearer ${user2.accessToken}`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Not found or no album.read access'));

      const list = await request(app).get('/albums').set('Authorization', `Bearer ${user2.accessToken}`);
      expect(list.status).toBe(200);
      expect(list.body).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: shared.id })]));

      const stats = await getAlbumStatistics(asAuth(user2.accessToken));
      expect(stats.shared).toBe(0);

      const buckets = await request(app)
        .get('/timeline/buckets')
        .query({ albumId: shared.id })
        .set('Authorization', `Bearer ${user2.accessToken}`);
      expect(buckets.status).toBe(400);

      const asset = await request(app)
        .get(`/assets/${privateAsset.id}`)
        .set('Authorization', `Bearer ${user2.accessToken}`);
      expect(asset.status).toBe(400);
    });

    it('should still hide the shared private album from the co-viewer when only the owner mode is on', async () => {
      await enable(user1.accessToken);
      const { status } = await request(app)
        .get(`/albums/${shared.id}`)
        .set('Authorization', `Bearer ${user2.accessToken}`);
      expect(status).toBe(400);
    });

    it('should show the shared private album to a co-viewer whose own mode is on', async () => {
      await enable(user2.accessToken);
      const info = await getAlbumInfo({ id: shared.id }, asAuth(user2.accessToken));
      expect(info.assetCount).toBe(2);
      const list = await request(app).get('/albums').set('Authorization', `Bearer ${user2.accessToken}`);
      expect(list.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: shared.id, assetCount: 2 })]));
      const stats = await getAlbumStatistics(asAuth(user2.accessToken));
      expect(stats.shared).toBe(1);
      const ids = await albumAssetIds(shared.id, user2);
      expect(ids).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining([plainAsset.id, privateAsset.id]));

      const { status, body } = await request(app)
        .get(`/assets/${privateAsset.id}`)
        .set('Authorization', `Bearer ${user2.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ id: privateAsset.id }));
    });

    it('should require the editor mode to add assets to a private album', async () => {
      const editorAsset = await utils.createAsset(user2.accessToken);

      const { status, body } = await request(app)
        .put(`/albums/${shared.id}/assets`)
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .send({ ids: [editorAsset.id] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Not found or no albumAsset.create access'));

      await enable(user2.accessToken);
      const results = await addAssetsToAlbum(
        { id: shared.id, albumAddAssetsDto: { ids: [editorAsset.id] } },
        asAuth(user2.accessToken),
      );
      expect(results).toEqual([expect.objectContaining({ id: editorAsset.id, success: true })]);

      const info = await getAssetInfo({ id: editorAsset.id }, asAuth(user2.accessToken));
      expect(info.isPrivate).toBe(true);
    });
  });

  describe('sharing private assets (confirmPrivate)', () => {
    const editor = { userId: '', role: AlbumUserRole.Editor };

    beforeAll(() => {
      editor.userId = user2.userId;
    });

    it('should require confirmPrivate to create an album with other users and private assets', async () => {
      await enable(user1.accessToken);
      const { status, body } = await request(app)
        .post('/albums')
        .set(authHeader(user1.accessToken))
        .send({ albumName: 'confirm create', albumUsers: [editor], assetIds: [plainAsset.id, privateAsset.id] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Album contains private assets, confirmPrivate is required'));

      const created = await request(app)
        .post('/albums')
        .set(authHeader(user1.accessToken))
        .send({
          albumName: 'confirm create',
          albumUsers: [editor],
          assetIds: [plainAsset.id, privateAsset.id],
          confirmPrivate: true,
        });
      expect(created.status).toBe(201);
      expect(created.body.albumUsers).toEqual(
        expect.arrayContaining([expect.objectContaining({ user: expect.objectContaining({ id: user2.userId }) })]),
      );
      await enable(user2.accessToken);
      const info = await getAlbumInfo({ id: created.body.id }, asAuth(user2.accessToken));
      expect(info.assetCount).toBe(2);
    });

    it('should not require confirmPrivate to create an album with private assets and no other users', async () => {
      await enable(user1.accessToken);
      const { status, body } = await request(app)
        .post('/albums')
        .set(authHeader(user1.accessToken))
        .send({ albumName: 'confirm create alone', assetIds: [privateAsset.id] });
      expect(status).toBe(201);
      expect(body.albumUsers).toHaveLength(1);
    });

    it('should require confirmPrivate to add private assets to an album shared with other users', async () => {
      await enable(user1.accessToken);
      const target = await utils.createAlbum(user1.accessToken, { albumName: 'confirm add', albumUsers: [editor] });

      const { status, body } = await request(app)
        .put(`/albums/${target.id}/assets`)
        .set(authHeader(user1.accessToken))
        .send({ ids: [plainAsset.id, privateAsset.id] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Album contains private assets, confirmPrivate is required'));
      await expect(getAlbumInfo({ id: target.id }, asAuth(user1.accessToken))).resolves.toMatchObject({
        assetCount: 0,
      });

      const plainOnly = await request(app)
        .put(`/albums/${target.id}/assets`)
        .set(authHeader(user1.accessToken))
        .send({ ids: [plainAsset.id] });
      expect(plainOnly.status).toBe(200);
      expect(plainOnly.body).toEqual([expect.objectContaining({ id: plainAsset.id, success: true })]);

      const confirmed = await request(app)
        .put(`/albums/${target.id}/assets`)
        .set(authHeader(user1.accessToken))
        .send({ ids: [privateAsset.id], confirmPrivate: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toEqual([expect.objectContaining({ id: privateAsset.id, success: true })]);
      await expect(getAlbumInfo({ id: target.id }, asAuth(user1.accessToken))).resolves.toMatchObject({
        isPrivate: true,
        assetCount: 2,
      });
    });

    it('should require confirmPrivate to add private assets to an album behind a shared link', async () => {
      await enable(user1.accessToken);
      const target = await utils.createAlbum(user1.accessToken, { albumName: 'confirm link' });
      await utils.createSharedLink(user1.accessToken, { type: SharedLinkType.Album, albumId: target.id });

      const { status, body } = await request(app)
        .put(`/albums/${target.id}/assets`)
        .set(authHeader(user1.accessToken))
        .send({ ids: [privateAsset.id] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Album contains private assets, confirmPrivate is required'));

      const confirmed = await request(app)
        .put(`/albums/${target.id}/assets`)
        .set(authHeader(user1.accessToken))
        .send({ ids: [privateAsset.id], confirmPrivate: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toEqual([expect.objectContaining({ id: privateAsset.id, success: true })]);
    });

    it('should require confirmPrivate to add private assets to shared albums in bulk', async () => {
      await enable(user1.accessToken);
      const target = await utils.createAlbum(user1.accessToken, { albumName: 'confirm bulk', albumUsers: [editor] });
      const mine = await utils.createAlbum(user1.accessToken, { albumName: 'confirm bulk alone' });

      const { status, body } = await request(app)
        .put('/albums/assets')
        .set(authHeader(user1.accessToken))
        .send({ albumIds: [target.id, mine.id], assetIds: [privateAsset.id] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Album contains private assets, confirmPrivate is required'));
      // nothing was written to either album
      await expect(getAlbumInfo({ id: mine.id }, asAuth(user1.accessToken))).resolves.toMatchObject({ assetCount: 0 });

      const alone = await request(app)
        .put('/albums/assets')
        .set(authHeader(user1.accessToken))
        .send({ albumIds: [mine.id], assetIds: [privateAsset.id] });
      expect(alone.status).toBe(200);
      expect(alone.body).toEqual({ success: true });

      const confirmed = await request(app)
        .put('/albums/assets')
        .set(authHeader(user1.accessToken))
        .send({ albumIds: [target.id], assetIds: [privateAsset.id], confirmPrivate: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toEqual({ success: true });
      await expect(getAlbumInfo({ id: target.id }, asAuth(user1.accessToken))).resolves.toMatchObject({
        isPrivate: true,
        assetCount: 1,
      });
    });
  });

  describe('/shared-links', () => {
    let privateAlbum: AlbumResponseDto;
    let albumLinkKey: string;

    beforeAll(async () => {
      await enable(user1.accessToken);
      privateAlbum = await utils.createAlbum(user1.accessToken, {
        albumName: 'linked private',
        assetIds: [plainAsset.id, privateAsset.id],
      });
      privateAlbum = await getAlbumInfo({ id: privateAlbum.id }, asAuth(user1.accessToken));
      expect(privateAlbum.isPrivate).toBe(true);
      await disable(user1.accessToken);
    });

    it('should require confirmPrivate for an individual link with private assets', async () => {
      await enable(user1.accessToken);
      const { status, body } = await request(app)
        .post('/shared-links')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ type: SharedLinkType.Individual, assetIds: [plainAsset.id, privateAsset.id] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Shared link would expose private assets, confirmPrivate is required'));
    });

    it('should create an individual link with confirmPrivate and always return the private asset', async () => {
      await enable(user1.accessToken);
      const { status, body } = await request(app)
        .post('/shared-links')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ type: SharedLinkType.Individual, assetIds: [plainAsset.id, privateAsset.id], confirmPrivate: true });
      expect(status).toBe(201);

      await disable(user1.accessToken);
      const link = await getMySharedLink({ key: body.key });
      const ids = link.assets.map(({ id }) => id);
      expect(ids).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining([plainAsset.id, privateAsset.id]));

      const thumbnail = await request(app).get(`/assets/${privateAsset.id}/thumbnail`).query({ key: body.key });
      expect(thumbnail.status).toBe(200);
    });

    it('should require confirmPrivate for an album link on a private album', async () => {
      // the album is hidden without the mode, so the link can only be created with it on
      await enable(user1.accessToken);
      const { status, body } = await request(app)
        .post('/shared-links')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ type: SharedLinkType.Album, albumId: privateAlbum.id });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Shared link would expose private assets, confirmPrivate is required'));
    });

    it('should create an album link with confirmPrivate and always return the private asset', async () => {
      await enable(user1.accessToken);
      const { status, body } = await request(app)
        .post('/shared-links')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ type: SharedLinkType.Album, albumId: privateAlbum.id, confirmPrivate: true });
      expect(status).toBe(201);

      const link = await getMySharedLink({ key: body.key });
      expect(link.album?.assetCount).toBe(2);
      albumLinkKey = body.key;

      const info = await getDownloadInfo({ key: body.key, downloadInfoDto: { albumId: privateAlbum.id } });
      const downloadIds = info.archives.flatMap(({ assetIds }) => assetIds);
      expect(downloadIds).toHaveLength(2);
      expect(downloadIds).toEqual(expect.arrayContaining([plainAsset.id, privateAsset.id]));

      const thumbnail = await request(app).get(`/assets/${privateAsset.id}/thumbnail`).query({ key: body.key });
      expect(thumbnail.status).toBe(200);
    });

    // Known server gap: the album timeline (GET /timeline/buckets?albumId=&key=) scopes on toPrivateScope(auth),
    // which never treats a shared link as private scope, so the link viewer gets assetCount 2 but only the plain
    // asset in the buckets. album.service.toAlbumScope and download.service already special-case auth.sharedLink;
    // asset.repository.getTimeBuckets/getTimeBucket should do the same. Unskip once that lands.
    it('should list the private asset in the album link timeline', async () => {
      const ids = await albumAssetIds(privateAlbum.id, { key: albumLinkKey });
      expect(ids).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining([plainAsset.id, privateAsset.id]));
    });

    it('should refuse the owner album download with the mode off and serve it with the mode on', async () => {
      const { status, body } = await request(app)
        .post('/download/info')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .send({ albumId: privateAlbum.id });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Not found or no album.download access'));

      await enable(user1.accessToken);
      const shown = await getDownloadInfo({ downloadInfoDto: { albumId: privateAlbum.id } }, asAuth(user1.accessToken));
      const ids = shown.archives.flatMap(({ assetIds }) => assetIds);
      expect(ids).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining([plainAsset.id, privateAsset.id]));
    });
  });

  describe('/activities', () => {
    let album: AlbumResponseDto;

    beforeAll(async () => {
      await enable(user1.accessToken);
      album = await utils.createAlbum(user1.accessToken, {
        albumName: 'activity',
        assetIds: [plainAsset.id, privateAsset.id],
      });
      await createActivity(
        {
          activityCreateDto: {
            albumId: album.id,
            assetId: privateAsset.id,
            type: ReactionType.Comment,
            comment: 'private comment',
          },
        },
        asAuth(user1.accessToken),
      );
      await createActivity(
        {
          activityCreateDto: {
            albumId: album.id,
            assetId: plainAsset.id,
            type: ReactionType.Comment,
            comment: 'plain comment',
          },
        },
        asAuth(user1.accessToken),
      );
      await disable(user1.accessToken);
    });

    it('should refuse activity on a private album with the mode off', async () => {
      const auth = { Authorization: `Bearer ${user1.accessToken}` };
      const list = await request(app).get('/activities').query({ albumId: album.id }).set(auth);
      expect(list.status).toBe(400);
      expect(list.body).toEqual(errorDto.badRequest('Not found or no album.read access'));

      const stats = await request(app).get('/activities/statistics').query({ albumId: album.id }).set(auth);
      expect(stats.status).toBe(400);

      const create = await request(app)
        .post('/activities')
        .set(auth)
        .send({ albumId: album.id, type: ReactionType.Comment, comment: 'blind' });
      expect(create.status).toBe(400);
      expect(create.body).toEqual(errorDto.badRequest('Not found or no activity.create access'));
    });

    it('should show activity on the private album with the mode on', async () => {
      await enable(user1.accessToken);
      const activities = await getActivities({ albumId: album.id }, asAuth(user1.accessToken));
      const assetIds = activities.map(({ assetId }) => assetId);
      expect(assetIds).toHaveLength(2);
      expect(assetIds).toEqual(expect.arrayContaining([plainAsset.id, privateAsset.id]));

      const stats = await getActivityStatistics(
        { albumId: album.id, assetId: privateAsset.id },
        asAuth(user1.accessToken),
      );
      expect(stats).toEqual({ comments: 1, likes: 0 });
    });
  });

  describe('trash', () => {
    let trashedPrivate: AssetMediaResponseDto;
    let trashedPlain: AssetMediaResponseDto;

    beforeAll(async () => {
      [trashedPrivate, trashedPlain] = await Promise.all([
        utils.createAsset(user1.accessToken, { fileCreatedAt: bucketDate }),
        utils.createAsset(user1.accessToken, { fileCreatedAt: bucketDate }),
      ]);

      await enable(user1.accessToken);
      await markPrivate(user1.accessToken, trashedPrivate.id);
      await utils.deleteAssets(user1.accessToken, [trashedPrivate.id, trashedPlain.id]);
      await disable(user1.accessToken);
    });

    it('should hide a trashed private asset with the mode off', async () => {
      const bucket = await findBucket(user1.accessToken, { isTrashed: true });
      expect(bucket).toBeDefined();
      const assets = await getTimeBucket(
        { timeBucket: bucket!.timeBucket, isTrashed: true },
        asAuth(user1.accessToken),
      );
      expect(assets.id).toContain(trashedPlain.id);
      expect(assets.id).not.toContain(trashedPrivate.id);

      const { status } = await request(app)
        .get(`/assets/${trashedPrivate.id}`)
        .set('Authorization', `Bearer ${user1.accessToken}`);
      expect(status).toBe(400);
    });

    it('should show a trashed private asset with the mode on', async () => {
      await enable(user1.accessToken);
      const bucket = await findBucket(user1.accessToken, { isTrashed: true });
      const assets = await getTimeBucket(
        { timeBucket: bucket!.timeBucket, isTrashed: true },
        asAuth(user1.accessToken),
      );
      expect(assets.id).toContain(trashedPlain.id);
      expect(assets.id).toContain(trashedPrivate.id);

      const info = await getAssetInfo({ id: trashedPrivate.id }, asAuth(user1.accessToken));
      expect(info).toEqual(expect.objectContaining({ id: trashedPrivate.id, isPrivate: true, isTrashed: true }));
    });
  });
});
