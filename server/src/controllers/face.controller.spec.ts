import { FaceController } from 'src/controllers/face.controller';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PersonService } from 'src/services/person.service';
import request from 'supertest';
import { errorDto } from 'test/medium/responses';
import { factory } from 'test/small.factory';
import { automock, ControllerContext, controllerSetup, mockBaseService } from 'test/utils';

const face = () => ({
  assetId: factory.uuid(),
  personId: factory.uuid(),
  imageWidth: 1280,
  imageHeight: 720,
  x: 600,
  y: 100,
  width: 80,
  height: 90,
});

describe(FaceController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(PersonService);

  beforeAll(async () => {
    ctx = await controllerSetup(FaceController, [
      { provide: PersonService, useValue: service },
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('POST /faces', () => {
    it('should accept a frame timestamp and an embedding', async () => {
      const dto = { ...face(), frameTimestamp: 12_345, embedding: Array.from({ length: 512 }, () => 0.5) };
      const { status } = await request(ctx.getHttpServer()).post('/faces').send(dto);
      expect(status).toBe(201);
      expect(service.createFace).toHaveBeenCalledWith(undefined, dto);
    });

    it('should require the frame timestamp to be a positive integer', async () => {
      const negative = await request(ctx.getHttpServer())
        .post('/faces')
        .send({ ...face(), frameTimestamp: -1 });
      expect(negative.status).toBe(400);
      expect(negative.body).toEqual(
        errorDto.validationError([{ path: ['frameTimestamp'], message: 'Too small: expected number to be >=0' }]),
      );

      const fraction = await request(ctx.getHttpServer())
        .post('/faces')
        .send({ ...face(), frameTimestamp: 1.5 });
      expect(fraction.status).toBe(400);
      expect(service.createFace).not.toHaveBeenCalled();
    });

    it('should require 512 embedding values', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/faces')
        .send({ ...face(), embedding: [0.1, 0.2] });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['embedding'], message: 'Too small: expected array to have >=512 items' }]),
      );
    });

    it('should refuse an embedding of only zeros', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/faces')
        .send({ ...face(), embedding: Array.from({ length: 512 }, () => 0) });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['embedding'], message: 'Embedding must not be all zeros' }]),
      );
      expect(service.createFace).not.toHaveBeenCalled();
    });
  });
});
