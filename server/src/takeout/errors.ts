// Error classes of the archive reader (single-pass design 6.7). Data errors carry the compressed byte offset where
// they were detected; I/O errors from node:fs pass through untouched.

/** tgz: premature end, bad tar header, inflate error; zip: EOCD or central directory unreadable */
export class ArchiveDataError extends Error {
  constructor(
    message: string,
    public byteOffset: number | null = null,
  ) {
    super(message);
    this.name = 'ArchiveDataError';
  }
}

/** tgz: the gzip trailer (CRC-32 or ISIZE) does not match: no entry of the part can be trusted */
export class GzipIntegrityError extends Error {
  constructor(
    message: string,
    public byteOffset: number | null = null,
  ) {
    super(message);
    this.name = 'GzipIntegrityError';
  }
}

/** zip: one entry is unreadable (local header, method, inflate, length or CRC-32); the rest of the part is fine */
export class EntryDataError extends Error {
  constructor(
    message: string,
    public byteOffset: number | null = null,
  ) {
    super(message);
    this.name = 'EntryDataError';
  }
}

/** The file changed while it was read (size, mtime, ctime or inode differ, or it ended early) */
export class ArchiveChangedError extends Error {
  constructor(message = 'the archive changed while it was read') {
    super(message);
    this.name = 'ArchiveChangedError';
  }
}

/** The file disappeared while it was read */
export class PartMissingError extends Error {
  code = 'ENOENT';
  constructor(message = 'the archive file is missing') {
    super(message);
    this.name = 'PartMissingError';
  }
}

export function isArchiveDataError(error: unknown): error is ArchiveDataError | GzipIntegrityError {
  return error instanceof ArchiveDataError || error instanceof GzipIntegrityError;
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
