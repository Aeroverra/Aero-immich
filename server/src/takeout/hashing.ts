import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';

// A pass-through transform that computes the SHA-1 and the byte count of everything piped through it.
export function hashTap(): { stream: Transform; result: () => { checksum: Buffer; size: number } } {
  const hash = createHash('sha1');
  let size = 0;
  let digest: Buffer | null = null;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  return {
    stream,
    result: () => {
      digest ??= hash.digest();
      return { checksum: digest, size };
    },
  };
}

export function sha1(data: Buffer): Buffer {
  return createHash('sha1').update(data).digest();
}
