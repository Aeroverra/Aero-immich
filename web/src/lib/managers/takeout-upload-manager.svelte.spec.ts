import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { isTakeoutArchiveName, TakeoutUploadManager } from '$lib/managers/takeout-upload-manager.svelte';
import { uploadRequest } from '$lib/utils';

vi.mock('$lib/utils/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils/i18n')>();
  return { ...actual, getFormatter: () => Promise.resolve((key: string) => key) };
});

vi.mock('$lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/utils')>();
  return { ...actual, uploadRequest: vi.fn() };
});

const uploadRequestMock = vi.mocked(uploadRequest);

const makeFile = (name: string, size: number): File => {
  const file = new File([new Uint8Array(size)], name, { type: 'application/octet-stream' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('isTakeoutArchiveName', () => {
  it('accepts valid takeout archive names', () => {
    expect(isTakeoutArchiveName('takeout-20260914T211500Z-1-001.tgz')).toBe(true);
    expect(isTakeoutArchiveName('takeout-20260915T001353Z-001.zip')).toBe(true);
    expect(isTakeoutArchiveName('takeout-20260915T001353Z-001.tar.gz')).toBe(true);
  });

  it('rejects other names', () => {
    expect(isTakeoutArchiveName('photo.jpg')).toBe(false);
    expect(isTakeoutArchiveName('takeout-20260914T211500Z-1-001.part')).toBe(false);
  });
});

describe('TakeoutUploadManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses files whose name is not a takeout archive', async () => {
    const manager = new TakeoutUploadManager();
    await manager.add([makeFile('holiday.jpg', 10)]);
    expect(manager.items).toHaveLength(0);
    expect(sdkMock.createTakeoutUpload).not.toHaveBeenCalled();
  });

  it('uploads a file in chunks until the offset reaches the size', async () => {
    sdkMock.createTakeoutUpload.mockResolvedValue({
      id: 'upload-1',
      fileName: 'takeout-20260914T211500Z-1-001.tgz',
      size: 250,
      offset: 0,
      chunkSize: 100,
      stale: false,
    });

    let offset = 0;
    uploadRequestMock.mockImplementation(({ headers }) => {
      const requestOffset = Number(headers?.['Upload-Offset'] ?? '0');
      offset = Math.min(requestOffset + 100, 250);
      return Promise.resolve({
        data: { id: 'upload-1', offset, chunkSize: 100, size: 250, stale: false, fileName: 'x' },
        status: 200,
      });
    });

    const manager = new TakeoutUploadManager();
    await manager.add([makeFile('takeout-20260914T211500Z-1-001.tgz', 250)]);

    for (let i = 0; i < 20 && manager.items[0]?.status !== 'completed'; i++) {
      await flush();
    }

    expect(uploadRequestMock).toHaveBeenCalledTimes(3);
    expect(manager.items[0].status).toBe('completed');
    expect(manager.items[0].offset).toBe(250);
  });

  it('adopts the server offset on a 409 conflict', async () => {
    sdkMock.createTakeoutUpload.mockResolvedValue({
      id: 'upload-1',
      fileName: 'takeout-20260914T211500Z-1-001.tgz',
      size: 100,
      offset: 0,
      chunkSize: 100,
      stale: false,
    });
    sdkMock.getTakeoutUpload.mockResolvedValue({
      id: 'upload-1',
      fileName: 'takeout-20260914T211500Z-1-001.tgz',
      size: 100,
      offset: 100,
      chunkSize: 100,
      stale: false,
    });

    let calls = 0;
    uploadRequestMock.mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return Promise.reject(Object.assign(new Error('conflict'), { statusCode: 409 }));
      }
      return Promise.resolve({
        data: { id: 'upload-1', offset: 100, chunkSize: 100, size: 100, stale: false, fileName: 'x' },
        status: 200,
      });
    });

    const manager = new TakeoutUploadManager();
    await manager.add([makeFile('takeout-20260914T211500Z-1-001.tgz', 100)]);

    for (let i = 0; i < 20 && manager.items[0]?.status !== 'completed'; i++) {
      await flush();
    }

    expect(sdkMock.getTakeoutUpload).toHaveBeenCalledWith({ id: 'upload-1' });
    expect(manager.items[0].status).toBe('completed');
    expect(manager.items[0].offset).toBe(100);
  });
});
