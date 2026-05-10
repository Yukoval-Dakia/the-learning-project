import { createId } from '@paralleldrive/cuid2';
import { Hono } from 'hono';
import type { AppEnv } from '../types';

export const assets = new Hono<AppEnv>();

const MAX_UPLOAD_BYTES = 8_000_000;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extFromMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

assets.post('/', async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file') as File | null;
  if (!file || typeof file.arrayBuffer !== 'function') {
    return c.json({ error: 'validation_error', message: 'file is required' }, 400);
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return c.json(
      { error: 'validation_error', message: `unsupported mime_type: ${file.type}` },
      400,
    );
  }
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    return c.json(
      { error: 'validation_error', message: `file size must be 1..${MAX_UPLOAD_BYTES}` },
      400,
    );
  }

  const bytes = await file.arrayBuffer();
  const id = createId();
  const storageKey = `images/${id}.${extFromMime(file.type)}`;
  const sha256 = await sha256Hex(bytes);
  const now = Math.floor(Date.now() / 1000);

  await c.env.IMAGES.put(storageKey, bytes, {
    httpMetadata: { contentType: file.type },
    customMetadata: { source_asset_id: id, sha256 },
  });

  try {
    await c.env.DB.prepare(
      `insert into source_asset (
        id, kind, storage_key, mime_type, byte_size, sha256, width, height, provenance, created_at
      ) values (?, 'image', ?, ?, ?, ?, null, null, ?, ?)`,
    )
      .bind(
        id,
        storageKey,
        file.type,
        file.size,
        sha256,
        JSON.stringify({ entrypoint: 'manual_record', original_name: file.name }),
        now,
      )
      .run();
  } catch (err) {
    // Roll back R2 to avoid orphans; if delete itself fails, log and rethrow original.
    await c.env.IMAGES.delete(storageKey).catch((delErr) => {
      console.error('source_asset insert failed AND R2 rollback failed', {
        storageKey,
        id,
        delErr,
      });
    });
    throw err;
  }

  return c.json({
    asset: {
      id,
      kind: 'image' as const,
      storage_key: storageKey,
      mime_type: file.type,
      byte_size: file.size,
      sha256,
    },
  });
});
