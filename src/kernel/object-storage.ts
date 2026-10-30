import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

export interface R2Client {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  /** Optional for existing adapters; immutable writers must fail closed without it. */
  putIfAbsent?(key: string, body: Uint8Array, contentType?: string): Promise<'created' | 'exists'>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

export function createR2Client(client: S3Client, bucket: string): R2Client {
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async putIfAbsent(key, body, contentType) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            IfNoneMatch: '*',
          }),
        );
        return 'created';
      } catch (err) {
        // 412 means an object already exists, not that it has the right bytes.
        // The immutable asset owner must read and verify it before issuing a ref.
        if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 412) {
          return 'exists';
        }
        throw err;
      }
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!res.Body) return null;
        const chunks: Uint8Array[] = [];
        // S3 GetObject body is an AsyncIterable<Uint8Array> in Node.
        for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        return out;
      } catch (err) {
        if (err instanceof NoSuchKey) return null;
        throw err;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

// Singleton helper for production use. Reads env at first call.
let _r2: R2Client | undefined;
export function getR2(): R2Client {
  if (_r2) return _r2;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      'R2 env not configured: need R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.',
    );
  }
  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  _r2 = createR2Client(client, bucket);
  return _r2;
}
