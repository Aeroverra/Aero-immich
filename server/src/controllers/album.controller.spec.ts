import { AlbumController } from 'src/controllers/album.controller';
import { AlbumService } from 'src/services/album.service';
import request from 'supertest';
import { factory } from 'test/small.factory';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils';

describe(AlbumController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(AlbumService);

  beforeAll(async () => {
    ctx = await controllerSetup(AlbumController, [{ provide: AlbumService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /albums', () => {
    it('should reject an invalid shared param', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/albums?isShared=invalid');
      expect(status).toEqual(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['isShared'], message: 'Invalid option: expected one of "true"|"false"' },
        ]),
      );
    });

    it('should reject an invalid assetId param', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/albums?assetId=invalid');
      expect(status).toEqual(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['assetId'], message: 'Invalid UUID' }]));
    });
  });

  describe('POST /albums/for-assets', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).post('/albums/for-assets').send({ assetIds: [] });
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should reject an invalid asset id', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/albums/for-assets')
        .send({ assetIds: ['invalid'] });
      expect(status).toEqual(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['assetIds', 0], message: 'Invalid UUID' }]));
    });

    it('should accept a list of asset ids in the body', async () => {
      const assetIds = Array.from({ length: 1000 }, () => factory.uuid());
      service.getAllForAssets.mockResolvedValue([]);
      const { status } = await request(ctx.getHttpServer()).post('/albums/for-assets').send({ assetIds });
      expect(status).toEqual(200);
      expect(service.getAllForAssets).toHaveBeenCalledWith(undefined, { assetIds });
    });
  });
});
