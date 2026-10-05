import {
  createTakeoutUpload,
  deleteTakeoutUpload,
  getBaseUrl,
  getTakeoutUpload,
  type TakeoutUploadDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { AbortError, uploadRequest } from '$lib/utils';
import { getFormatter } from '$lib/utils/i18n';

// Same shape the server accepts (server/src/takeout/part-names.ts).
const TAKEOUT_NAME_RE = /^takeout-(\d{8}T\d{6}Z)-(?:(\d+)-)?(\d{3})\.(zip|tgz|tar\.gz)$/i;

export const isTakeoutArchiveName = (fileName: string): boolean => TAKEOUT_NAME_RE.test(fileName);

const BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30];
const MAX_PARALLEL = 2;

export type TakeoutUploadStatus = 'queued' | 'uploading' | 'paused' | 'error' | 'completed' | 'cancelled';

export class TakeoutUploadItem {
  id = $state<string | undefined>();
  fileName = $state('');
  size = $state(0);
  offset = $state(0);
  chunkSize = $state(0);
  status = $state<TakeoutUploadStatus>('queued');
  stale = $state(false);
  error = $state<string | undefined>();
  file: File | undefined;
  controller: AbortController | undefined;

  progress = $derived(this.size > 0 ? this.offset / this.size : 0);

  constructor(init: Partial<TakeoutUploadItem> & { fileName: string; size: number }) {
    Object.assign(this, init);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

const statusCodeOf = (error: unknown): number | undefined => {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    return (error as { statusCode?: number }).statusCode;
  }
};

export class TakeoutUploadManager {
  items = $state<TakeoutUploadItem[]>([]);

  #beforeUnloadBound = (event: BeforeUnloadEvent) => {
    if (!this.hasActiveUploads) {
      return;
    }
    // preventDefault triggers the browser's unsaved-changes prompt in modern engines.
    event.preventDefault();
  };

  get hasActiveUploads(): boolean {
    return this.items.some((item) => item.status === 'uploading' || item.status === 'queued');
  }

  // Merge the uploads the server already knows about; entries with no local File stay paused until re-picked.
  syncFromServer(uploads: TakeoutUploadDto[]): void {
    for (const upload of uploads) {
      const existing = this.items.find((item) => item.fileName === upload.fileName);
      if (existing) {
        existing.id = upload.id;
        existing.offset = upload.offset;
        existing.chunkSize = upload.chunkSize;
        existing.stale = upload.stale;
        if (existing.status !== 'uploading' && !existing.file) {
          existing.status = 'paused';
        }
        continue;
      }

      this.items.push(
        new TakeoutUploadItem({
          id: upload.id,
          fileName: upload.fileName,
          size: upload.size,
          offset: upload.offset,
          chunkSize: upload.chunkSize,
          stale: upload.stale,
          status: 'paused',
        }),
      );
    }
  }

  async add(files: File[]): Promise<void> {
    const translate = await getFormatter();
    for (const file of files) {
      if (!isTakeoutArchiveName(file.name)) {
        toastManager.danger(translate('takeout_upload_invalid_name'));
        continue;
      }

      const existing = this.items.find((item) => item.fileName === file.name);
      if (existing) {
        existing.file = file;
        existing.size = file.size;
        if (existing.status !== 'uploading') {
          existing.status = 'queued';
          existing.error = undefined;
        }
        continue;
      }

      this.items.push(new TakeoutUploadItem({ fileName: file.name, size: file.size, file }));
    }

    this.#registerBeforeUnload();
    this.#pump();
  }

  pause(item: TakeoutUploadItem): void {
    if (item.status !== 'uploading' && item.status !== 'queued') {
      return;
    }
    item.status = 'paused';
    item.controller?.abort();
    this.#pump();
  }

  resume(item: TakeoutUploadItem): void {
    if (item.status !== 'paused' && item.status !== 'error') {
      return;
    }
    item.status = 'queued';
    item.error = undefined;
    this.#registerBeforeUnload();
    this.#pump();
  }

  async cancel(item: TakeoutUploadItem): Promise<void> {
    item.controller?.abort();
    item.status = 'cancelled';
    if (item.id) {
      try {
        await deleteTakeoutUpload({ id: item.id });
      } catch {
        // The partial file may already be gone; drop the row regardless.
      }
    }
    this.remove(item);
  }

  remove(item: TakeoutUploadItem): void {
    this.items = this.items.filter((current) => current !== item);
    this.#pump();
  }

  #activeCount(): number {
    return this.items.filter((item) => item.status === 'uploading').length;
  }

  #pump(): void {
    for (const item of this.items) {
      if (this.#activeCount() >= MAX_PARALLEL) {
        break;
      }
      if (item.status === 'queued' && item.file) {
        void this.#run(item);
      }
    }
  }

  async #run(item: TakeoutUploadItem): Promise<void> {
    if (!item.file) {
      item.status = 'paused';
      return;
    }

    item.status = 'uploading';
    item.error = undefined;
    const controller = new AbortController();
    item.controller = controller;
    const { signal } = controller;

    try {
      if (!item.id) {
        const session = await createTakeoutUpload({
          takeoutUploadCreateDto: { fileName: item.fileName, size: item.size },
        });
        item.id = session.id;
        item.offset = session.offset;
        item.chunkSize = session.chunkSize;
      }

      let attempt = 0;
      while (item.offset < item.size) {
        if (signal.aborted) {
          throw new AbortError();
        }

        const end = Math.min(item.offset + item.chunkSize, item.size);
        const blob = item.file.slice(item.offset, end);

        try {
          const { data } = await uploadRequest<TakeoutUploadDto>({
            url: getBaseUrl() + '/takeouts/uploads/' + item.id,
            method: 'PUT',
            data: blob,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Upload-Offset': String(item.offset),
            },
            signal,
          });
          item.offset = data.offset;
          item.chunkSize = data.chunkSize || item.chunkSize;
          attempt = 0;
        } catch (error) {
          if (error instanceof AbortError || signal.aborted) {
            throw error;
          }

          if (statusCodeOf(error) === 409 && item.id) {
            // The server and client disagree on the offset; adopt the server's.
            const session = await getTakeoutUpload({ id: item.id });
            item.offset = session.offset;
            attempt = 0;
            continue;
          }

          if (attempt >= BACKOFF_SECONDS.length) {
            throw error;
          }
          await sleep(BACKOFF_SECONDS[attempt] * 1000, signal);
          attempt++;
        }
      }

      item.status = 'completed';
    } catch (error) {
      if (error instanceof AbortError || signal.aborted) {
        // cancel() may have set 'cancelled' before aborting this request.
        if ((item.status as TakeoutUploadStatus) !== 'cancelled') {
          item.status = 'paused';
        }
      } else {
        item.status = 'error';
        item.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      item.controller = undefined;
      if (!this.hasActiveUploads) {
        this.#unregisterBeforeUnload();
      }
      this.#pump();
    }
  }

  #beforeUnloadRegistered = false;

  #registerBeforeUnload(): void {
    if (typeof window === 'undefined' || this.#beforeUnloadRegistered) {
      return;
    }
    window.addEventListener('beforeunload', this.#beforeUnloadBound);
    this.#beforeUnloadRegistered = true;
  }

  #unregisterBeforeUnload(): void {
    if (typeof window === 'undefined' || !this.#beforeUnloadRegistered) {
      return;
    }
    window.removeEventListener('beforeunload', this.#beforeUnloadBound);
    this.#beforeUnloadRegistered = false;
  }
}
