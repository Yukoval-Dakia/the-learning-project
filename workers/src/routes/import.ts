import { unzipSync } from 'fflate';
import { Hono } from 'hono';
import { FK_ORDER, SCHEMA_VERSION } from '../export/constants';
import type { AppEnv } from '../types';

export const importRoute = new Hono<AppEnv>();

// biome-ignore lint/correctness/noUnusedVariables: used in Task 9
const INSERT_BATCH_SIZE = 50;

// biome-ignore lint/correctness/noUnusedVariables: used in Task 9
const _FK_ORDER = FK_ORDER;

interface ImportManifest {
  schema_version: string;
  exported_at: number;
  include_assets: boolean;
  row_counts: Record<string, number>;
  asset_count: number;
}

importRoute.post('/', async (c) => {
  if (c.req.query('confirm') !== 'wipe-and-reload') {
    return c.json(
      {
        error: 'confirm_required',
        message: 'pass ?confirm=wipe-and-reload to acknowledge wipe',
      },
      400,
    );
  }

  const ab = await c.req.arrayBuffer();
  if (ab.byteLength === 0) {
    return c.json({ error: 'validation_error', message: 'empty body' }, 400);
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(ab));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'invalid_zip', message: msg }, 400);
  }

  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) {
    return c.json(
      { error: 'invalid_zip', message: 'manifest.json missing from ZIP' },
      400,
    );
  }

  let manifest: ImportManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ImportManifest;
  } catch {
    return c.json(
      { error: 'invalid_zip', message: 'manifest.json is not valid JSON' },
      400,
    );
  }

  if (manifest.schema_version !== SCHEMA_VERSION) {
    return c.json(
      {
        error: 'schema_version_mismatch',
        expected: SCHEMA_VERSION,
        got: manifest.schema_version,
      },
      400,
    );
  }

  // TODO: wipe + reinsert + R2 — added in Task 9
  return c.json({ ok: true, stats: {}, assets_uploaded: 0, assets_failed: 0 });
});
