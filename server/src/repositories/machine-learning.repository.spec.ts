import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MachineLearningRepository, ModelTask, ModelType } from 'src/repositories/machine-learning.repository';
import { automock } from 'test/utils';
import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';

const config = {
  enabled: true,
  urls: ['http://immich-machine-learning:3003'],
  availabilityChecks: { enabled: false, timeout: 2000, interval: 30_000 },
} as any;

const faces = { imageWidth: 100, imageHeight: 80, [ModelTask.FACIAL_RECOGNITION]: [] };

/** jpeg-like bytes that contain a line break and dashes, like a multipart boundary would */
const image = Buffer.from([0xff, 0xd8, 0xff, 0x0d, 0x0a, 0x2d, 0x2d, 0x00, 0xd9]);

describe(MachineLearningRepository.name, () => {
  let sut: MachineLearningRepository;
  let directory: string;
  let fetchMock: ReturnType<typeof vitest.fn>;

  beforeEach(() => {
    sut = new MachineLearningRepository(
      // eslint-disable-next-line no-sparse-arrays
      automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }),
    );
    sut.setup(config);
    directory = mkdtempSync(join(tmpdir(), 'immich-ml-'));
    fetchMock = vitest.fn();
    vitest.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vitest.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });

  /** reads the request the repository sent back the way the machine learning service parses it */
  const getSentForm = (call = 0) => {
    const [url, init] = fetchMock.mock.calls[call];
    return new Request(url, init).formData();
  };

  it('should send an image file and the request as multipart form data', async () => {
    const imagePath = join(directory, 'preview.jpeg');
    writeFileSync(imagePath, image);
    fetchMock.mockResolvedValue(Response.json(faces));

    await expect(sut.detectFaces(imagePath, { modelName: 'buffalo_l', minScore: 0.7 })).resolves.toEqual({
      imageWidth: 100,
      imageHeight: 80,
      faces: [],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://immich-machine-learning:3003/predict'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': expect.stringMatching(/^multipart\/form-data; boundary=immich-/) },
      }),
    );
    const form = await getSentForm();
    expect(JSON.parse(form.get('entries') as string)).toEqual({
      [ModelTask.FACIAL_RECOGNITION]: {
        [ModelType.DETECTION]: { modelName: 'buffalo_l', options: { minScore: 0.7 } },
        [ModelType.RECOGNITION]: { modelName: 'buffalo_l' },
      },
    });
    const file = form.get('image') as File;
    expect(file.name).toBe('blob');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(image);
    expect(form.get('text')).toBeNull();
  });

  it('should send an image held in memory', async () => {
    fetchMock.mockResolvedValue(Response.json({ [ModelTask.SEARCH]: '[0.1,0.2]' }));
    const request = { [ModelTask.SEARCH]: { [ModelType.VISUAL]: { modelName: 'ViT-B-32__openai' } } };

    await expect(sut['predict']({ image }, request)).resolves.toEqual({ [ModelTask.SEARCH]: '[0.1,0.2]' });

    const form = await getSentForm();
    expect(JSON.parse(form.get('entries') as string)).toEqual(request);
    expect(Buffer.from(await (form.get('image') as File).arrayBuffer())).toEqual(image);
  });

  it('should send text as a form field', async () => {
    fetchMock.mockResolvedValue(Response.json({ [ModelTask.SEARCH]: '[0.1,0.2]' }));

    await expect(sut.encodeText('a dog on the beach', { modelName: 'ViT-B-32__openai' })).resolves.toBe('[0.1,0.2]');

    const form = await getSentForm();
    expect(form.get('text')).toBe('a dog on the beach');
    expect(form.get('image')).toBeNull();
  });

  it('should reject a payload without an image or text', async () => {
    await expect(sut['predict']({} as any, {} as any)).rejects.toThrow('Invalid input');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should send the same request to the next server', async () => {
    sut.setup({ ...config, urls: ['http://first:3003', 'http://second:3003'] });
    fetchMock
      .mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockResolvedValueOnce(Response.json({ [ModelTask.SEARCH]: '[1]' }));

    await expect(sut.encodeText('cat', { modelName: 'ViT-B-32__openai' })).resolves.toBe('[1]');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls.map(([, init]) => init);
    expect(second.body).toBe(first.body);
    const form = await getSentForm(1);
    expect(form.get('text')).toBe('cat');
  });
});
