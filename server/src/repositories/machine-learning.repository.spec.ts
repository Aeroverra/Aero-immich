import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { defaults } from 'src/dtos/config.dto';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository';
import { automock } from 'test/utils';

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
};

describe(MachineLearningRepository.name, () => {
  let sut: MachineLearningRepository;
  let logger: LoggingRepository;
  let server: Server;
  let status: number;
  let received: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      void readBody(request).then((body) => {
        received = body;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ 'speech-to-text': { language: 'en', segments: [] } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    status = 200;
    received = '';
    logger = automock(LoggingRepository, { args: [undefined, { getEnv: () => ({}) }], strict: false });
    sut = new MachineLearningRepository(logger);
    const { port } = server.address() as AddressInfo;
    sut.setup({
      ...defaults.machineLearning,
      urls: [`http://127.0.0.1:${port}/`],
      availabilityChecks: { ...defaults.machineLearning.availabilityChecks, enabled: false },
    });
  });

  afterEach(() => {
    sut.teardown();
  });

  describe('transcribe', () => {
    it('should send the audio as a form and return the transcription', async () => {
      await expect(
        sut.transcribe(Buffer.from('opus audio'), { modelName: 'large-v3-turbo', language: '', computeType: 'auto' }),
      ).resolves.toEqual({ language: 'en', segments: [] });

      expect(received).toContain('opus audio');
      expect(received).toContain('"speech-to-text"');
    });

    it('should not mark the server unhealthy when a transcription fails', async () => {
      status = 500;

      await expect(
        sut.transcribe(Buffer.from('opus audio'), { modelName: 'large-v3-turbo', language: '', computeType: 'auto' }),
      ).rejects.toThrow('failed for all URLs');

      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('unhealthy'));
    });
  });

  it('should mark the server unhealthy when another request fails', async () => {
    status = 500;

    await expect(sut.encodeText('a dog', { modelName: 'ViT-B-32__openai' })).rejects.toThrow('failed for all URLs');

    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('unhealthy'));
  });
});
