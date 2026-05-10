import { unzipSync } from 'fflate';
import { Hono } from 'hono';
import { FK_ORDER, SCHEMA_VERSION } from '../export/constants';
import type { AppEnv } from '../types';

export const importRoute = new Hono<AppEnv>();

const INSERT_BATCH_SIZE = 50;

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
    return c.json({ error: 'invalid_zip', message: 'manifest.json missing from ZIP' }, 400);
  }

  let manifest: ImportManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ImportManifest;
  } catch {
    return c.json({ error: 'invalid_zip', message: 'manifest.json is not valid JSON' }, 400);
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

  const dataBytes = entries['data.json'];
  if (!dataBytes) {
    return c.json({ error: 'invalid_zip', message: 'data.json missing from ZIP' }, 400);
  }
  let data: Record<string, Array<Record<string, unknown>>>;
  try {
    data = JSON.parse(new TextDecoder().decode(dataBytes)) as Record<
      string,
      Array<Record<string, unknown>>
    >;
  } catch {
    return c.json({ error: 'invalid_zip', message: 'data.json is not valid JSON' }, 400);
  }

  // Pre-flight: catch common shape errors BEFORE we wipe D1.
  const validationErrors: string[] = [];
  for (const t of FK_ORDER) {
    const rows = data[t];
    if (rows === undefined) continue; // table absent in ZIP — OK, treat as empty
    if (!Array.isArray(rows)) {
      validationErrors.push(`${t}: not an array`);
      continue;
    }
    if (rows.length === 0) continue;
    // Column shape uniformity: every row must have the same key set as row[0].
    const expectedCols = new Set(Object.keys(rows[0]));
    for (let i = 1; i < rows.length; i++) {
      const cols = new Set(Object.keys(rows[i]));
      if (cols.size !== expectedCols.size) {
        validationErrors.push(`${t}[${i}]: column count mismatch`);
        break;
      }
      let missing: string | null = null;
      for (const c of expectedCols) {
        if (!cols.has(c)) {
          missing = c;
          break;
        }
      }
      if (missing) {
        validationErrors.push(`${t}[${i}]: missing column ${missing}`);
        break;
      }
    }
  }
  if (validationErrors.length > 0) {
    return c.json(
      {
        error: 'data_validation_failed',
        message: 'Pre-flight validation caught issues; D1 was NOT wiped.',
        issues: validationErrors.slice(0, 20),
      },
      400,
    );
  }

  const stats: Record<string, { deleted: number; inserted: number }> = {};

  try {
    // Wipe in REVERSE FK order, one DELETE per table.
    for (const t of [...FK_ORDER].reverse()) {
      const r = (await c.env.DB.prepare(`delete from ${t}`).run()) as {
        meta?: { changes?: number };
      };
      stats[t] = { deleted: r.meta?.changes ?? 0, inserted: 0 };
    }

    // Insert in FORWARD FK order, chunked into D1 batches.
    for (const t of FK_ORDER) {
      const rows = data[t] ?? [];
      if (rows.length === 0) continue;
      const cols = Object.keys(rows[0]);
      const placeholders = `(${cols.map(() => '?').join(',')})`;
      for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
        const chunk = rows.slice(i, i + INSERT_BATCH_SIZE);
        const stmts = chunk.map((row) =>
          c.env.DB.prepare(`insert into ${t} (${cols.join(',')}) values ${placeholders}`).bind(
            ...cols.map((col) => row[col] ?? null),
          ),
        );
        await c.env.DB.batch(stmts);
        stats[t].inserted += chunk.length;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        error: 'restore_failed_mid_flight',
        message:
          'D1 may be in a half-wiped state. Re-run the same ZIP to retry — wipe is idempotent. ' +
          msg,
        partial_stats: stats,
      },
      500,
    );
  }

  // Re-PUT assets to R2.
  let assetsUploaded = 0;
  let assetsFailed = 0;
  if (manifest.include_assets) {
    for (const [path, bytes] of Object.entries(entries)) {
      if (!path.startsWith('assets/')) continue;
      const key = path.slice('assets/'.length);
      try {
        await c.env.IMAGES.put(key, bytes);
        assetsUploaded += 1;
      } catch (err) {
        console.error('import: R2 put failed', { key, err });
        assetsFailed += 1;
      }
    }
  }

  return c.json({ ok: true, stats, assets_uploaded: assetsUploaded, assets_failed: assetsFailed });
});
