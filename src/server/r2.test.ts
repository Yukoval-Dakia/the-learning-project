import { Readable } from 'node:stream';
import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createR2Client } from './r2';

describe('createR2Client', () => {
  let s3: { send: ReturnType<typeof vi.fn> };
  let r2: ReturnType<typeof createR2Client>;

  beforeEach(() => {
    s3 = { send: vi.fn() };
    r2 = createR2Client(s3 as unknown as S3Client, 'test-bucket');
  });

  afterEach(() => vi.clearAllMocks());

  it('put sends PutObjectCommand with bucket, key, body, contentType', async () => {
    s3.send.mockResolvedValueOnce({});
    await r2.put('k1', new Uint8Array([1, 2, 3]), 'image/png');
    expect(s3.send).toHaveBeenCalledTimes(1);
    const cmd = s3.send.mock.calls[0][0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('k1');
    expect(cmd.input.ContentType).toBe('image/png');
  });

  it('get returns Uint8Array when object exists', async () => {
    const bodyStream = Readable.from([new Uint8Array([7, 8, 9])]);
    s3.send.mockResolvedValueOnce({ Body: bodyStream });
    const out = await r2.get('k1');
    expect(out).toEqual(new Uint8Array([7, 8, 9]));
  });

  it('get returns null when NoSuchKey thrown', async () => {
    const err = new NoSuchKey({ message: 'gone', $metadata: {} });
    s3.send.mockRejectedValueOnce(err);
    const out = await r2.get('missing');
    expect(out).toBeNull();
  });

  it('get rethrows other errors', async () => {
    s3.send.mockRejectedValueOnce(new Error('network'));
    await expect(r2.get('x')).rejects.toThrow('network');
  });

  it('delete sends DeleteObjectCommand', async () => {
    s3.send.mockResolvedValueOnce({});
    await r2.delete('k1');
    const cmd = s3.send.mock.calls[0][0];
    expect(cmd.input.Bucket).toBe('test-bucket');
    expect(cmd.input.Key).toBe('k1');
  });
});
