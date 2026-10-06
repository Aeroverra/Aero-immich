import { PersonController } from 'src/controllers/person.controller';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PersonSuggestionService } from 'src/services/person-suggestion.service';
import { PersonService } from 'src/services/person.service';
import request from 'supertest';
import { errorDto } from 'test/medium/responses';
import { factory } from 'test/small.factory';
import { automock, ControllerContext, controllerSetup, mockBaseService } from 'test/utils';

describe(PersonController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(PersonService);
  const suggestionService = mockBaseService(PersonSuggestionService);

  beforeAll(async () => {
    ctx = await controllerSetup(PersonController, [
      { provide: PersonService, useValue: service },
      { provide: PersonSuggestionService, useValue: suggestionService },
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    suggestionService.resetAllMocks();
    ctx.reset();
  });

  describe('GET /people/suggestions', () => {
    it('should not be taken for a person id', async () => {
      await request(ctx.getHttpServer()).get('/people/suggestions').set('Authorization', `Bearer token`);
      expect(suggestionService.getAll).toHaveBeenCalledWith(undefined, { page: 1, size: 10 });
      expect(service.getById).not.toHaveBeenCalled();
    });

    it('should only take a uuid as the person', async () => {
      const { status } = await request(ctx.getHttpServer())
        .get('/people/suggestions')
        .query({ personId: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
    });

    it('should limit the page size', async () => {
      const { status } = await request(ctx.getHttpServer())
        .get('/people/suggestions')
        .query({ size: 51 })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
    });
  });

  describe('GET /people/suggestions/count', () => {
    it('should not be taken for a person id', async () => {
      const personId = factory.uuid();
      await request(ctx.getHttpServer())
        .get('/people/suggestions/count')
        .query({ personId })
        .set('Authorization', `Bearer token`);
      expect(suggestionService.getStatistics).toHaveBeenCalledWith(undefined, { personId });
      expect(service.getStatistics).not.toHaveBeenCalled();
    });
  });

  describe('POST /people/suggestions', () => {
    it('should require either a person or a face', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/people/suggestions')
        .send({ targetPersonId: factory.uuid() })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: [], message: 'Either personId or faceId is required, not both' }]),
      );
    });

    it('should refuse both a person and a face', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/people/suggestions')
        .send({ personId: factory.uuid(), faceId: factory.uuid(), targetPersonId: factory.uuid() })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
    });

    it('should refuse a score above 1', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/people/suggestions')
        .send({ personId: factory.uuid(), targetPersonId: factory.uuid(), score: 1.5 })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
    });
  });

  describe('PUT /people/suggestions/:id', () => {
    it('should require a uuid', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/people/suggestions/invalid')
        .send({ answer: 'same' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
    });

    it('should only take same, different or skipped', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put(`/people/suggestions/${factory.uuid()}`)
        .send({ answer: 'pending' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
    });

    it('should pass a name on', async () => {
      const id = factory.uuid();
      await request(ctx.getHttpServer())
        .put(`/people/suggestions/${id}`)
        .send({ answer: 'same', name: ' Cleo ' })
        .set('Authorization', `Bearer token`);
      expect(suggestionService.answer).toHaveBeenCalledWith(undefined, id, { answer: 'same', name: 'Cleo' });
    });
  });

  describe('DELETE /people/suggestions/:id/answer', () => {
    it('should require a uuid', async () => {
      const { status } = await request(ctx.getHttpServer())
        .delete('/people/suggestions/invalid/answer')
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
    });
  });

  describe('GET /people', () => {
    it(`should require closestPersonId to be a uuid`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get(`/people`)
        .query({ closestPersonId: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['closestPersonId'], message: 'Invalid UUID' }]));
    });

    it(`should require closestAssetId to be a uuid`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get(`/people`)
        .query({ closestAssetId: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['closestAssetId'], message: 'Invalid UUID' }]));
    });
  });

  describe('DELETE /people', () => {
    it('should require uuids in the body', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .delete('/people')
        .send({ ids: ['invalid'] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['ids', 0], message: 'Invalid UUID' }]));
    });

    it('should respond with 204', async () => {
      const { status } = await request(ctx.getHttpServer())
        .delete(`/people`)
        .send({ ids: [factory.uuid()] });
      expect(status).toBe(204);
      expect(service.deleteAll).toHaveBeenCalled();
    });
  });

  describe('PUT /people/:id', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).put(`/people/123`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: [], message: 'Invalid input: expected object, received undefined' }]),
      );
    });

    it(`should not allow a null name`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post(`/people`)
        .send({ name: null })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['name'], message: 'Invalid input: expected string, received null' }]),
      );
    });

    it(`should require featureFaceAssetId to be a uuid`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}`)
        .send({ featureFaceAssetId: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['featureFaceAssetId'], message: 'Invalid UUID' }]));
    });

    it(`should require isFavorite to be a boolean`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}`)
        .send({ isFavorite: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['isFavorite'], message: 'Invalid input: expected boolean, received string' },
        ]),
      );
    });

    it(`should require isHidden to be a boolean`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}`)
        .send({ isHidden: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['isHidden'], message: 'Invalid input: expected boolean, received string' }]),
      );
    });

    it('should not accept an invalid birth date (false)', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}`)
        .send({ birthDate: false });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['birthDate'], message: 'Invalid input: expected string, received boolean' },
        ]),
      );
    });

    it('should not accept an invalid birth date (number)', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}`)
        .send({ birthDate: 123_456 });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['birthDate'], message: 'Invalid input: expected string, received number' }]),
      );
    });

    it('should not accept a birth date in the future)', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}`)
        .send({ birthDate: '9999-01-01' });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['birthDate'], message: 'Birth date cannot be in the future' }]),
      );
    });
  });

  describe('PUT /people/:id/assets', () => {
    it('should require a valid person id', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/invalid/assets`)
        .send({ ids: [factory.uuid()] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });

    it('should require uuids in the body', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/people/${factory.uuid()}/assets`)
        .send({ ids: ['invalid'] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['ids', 0], message: 'Invalid UUID' }]));
    });

    it('should call the service', async () => {
      const personId = factory.uuid();
      const assetId = factory.uuid();
      const { status } = await request(ctx.getHttpServer())
        .put(`/people/${personId}/assets`)
        .send({ ids: [assetId] });
      expect(status).toBe(200);
      expect(service.addToAssets).toHaveBeenCalledWith(undefined, personId, { ids: [assetId] });
    });
  });

  describe('DELETE /people/:id/assets', () => {
    it('should require uuids in the body', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .delete(`/people/${factory.uuid()}/assets`)
        .send({ ids: ['invalid'] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['ids', 0], message: 'Invalid UUID' }]));
    });

    it('should call the service', async () => {
      const personId = factory.uuid();
      const assetId = factory.uuid();
      const { status } = await request(ctx.getHttpServer())
        .delete(`/people/${personId}/assets`)
        .send({ ids: [assetId] });
      expect(status).toBe(200);
      expect(service.removeFromAssets).toHaveBeenCalledWith(undefined, personId, { ids: [assetId] });
    });
  });

  describe('POST /people/assets/counts', () => {
    it('should require at least one asset', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/people/assets/counts').send({ assetIds: [] });
      expect(status).toBe(400);
    });

    it('should call the service', async () => {
      const assetId = factory.uuid();
      const { status } = await request(ctx.getHttpServer())
        .post('/people/assets/counts')
        .send({ assetIds: [assetId] });
      expect(status).toBe(200);
      expect(service.getAssetCounts).toHaveBeenCalledWith(undefined, { assetIds: [assetId] });
    });
  });

  describe('DELETE /people/:id', () => {
    it('should require a valid uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer()).delete(`/people/invalid`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });

    it('should respond with 204', async () => {
      const { status } = await request(ctx.getHttpServer()).delete(`/people/${factory.uuid()}`);
      expect(status).toBe(204);
      expect(service.delete).toHaveBeenCalled();
    });
  });
});
