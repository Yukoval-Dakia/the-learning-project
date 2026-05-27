import type { Db } from '@/db/client';
import type { R2Client } from '@/server/r2';
/**
 * buildBackupArchive — extract all table rows from Postgres + optional R2 assets,
 * then stream a ZIP via client-zip.
 *
 * restoreFromArchive — parse a ZIP produced by buildBackupArchive, wipe the DB,
 * then re-insert all rows + re-PUT R2 assets.
 */
import { downloadZip } from 'client-zip';
import { sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { FK_ORDER, MAX_INLINE_ASSETS, SCHEMA_VERSION, type TableName } from './constants';
import { buildMistakesCsv, buildReviewEventsCsv } from './csv';
import { type Manifest, buildReadme } from './readme';

// ─── Export ────────────────────────────────────────────────────────────────

export interface BuildBackupArchiveOpts {
  db: Db;
  r2: R2Client;
  includeAssets?: boolean;
}

export interface BuildBackupArchiveResult {
  stream: ReadableStream<Uint8Array>;
  /** HTTP 400 payload — set when includeAssets is true but count exceeds limit */
  error?: {
    error: string;
    count: number;
    limit: number;
    suggestion: string;
  };
  dateStamp: string;
}

export async function buildBackupArchive({
  db,
  r2,
  includeAssets = false,
}: BuildBackupArchiveOpts): Promise<BuildBackupArchiveResult> {
  const exportedAt = Math.floor(Date.now() / 1000);

  const tableRows: Record<string, Array<Record<string, unknown>>> = {};
  const rowCounts: Record<string, number> = {};

  for (const t of FK_ORDER) {
    // Use raw SQL to fetch every column without needing individual table schema imports.
    const rows = (await db.execute(sql.raw(`select * from "${t}"`))) as Array<
      Record<string, unknown>
    >;
    tableRows[t] = rows;
    rowCounts[t] = rows.length;
  }

  type Entry = { name: string; input: string | Uint8Array | ReadableStream; lastModified?: Date };
  const entries: Entry[] = [];

  const missingAssets: string[] = [];

  if (includeAssets) {
    const assets = tableRows.source_asset as Array<{ storage_key: string }>;
    if (assets.length > MAX_INLINE_ASSETS) {
      const dateStamp = new Date(exportedAt * 1000).toISOString().slice(0, 10);
      return {
        stream: new ReadableStream(), // unused
        error: {
          error: 'too_many_assets',
          count: assets.length,
          limit: MAX_INLINE_ASSETS,
          suggestion: 'export with ?include_assets=0 then copy per storage_key (see README)',
        },
        dateStamp,
      };
    }

    for (const asset of assets) {
      const bytes = await r2.get(asset.storage_key);
      if (!bytes) {
        missingAssets.push(asset.storage_key);
        continue;
      }
      entries.push({
        name: `assets/${asset.storage_key}`,
        input: bytes,
      });
    }
  }

  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    exported_at: exportedAt,
    include_assets: includeAssets,
    row_counts: rowCounts,
    asset_count: includeAssets ? rowCounts.source_asset - missingAssets.length : 0,
    missing_assets: missingAssets,
  };

  const mistakesCsv = buildMistakesCsv(
    tableRows as unknown as Record<string, Array<Record<string, unknown>>>,
  );
  const reviewEventsCsv = buildReviewEventsCsv(
    tableRows as unknown as Record<string, Array<Record<string, unknown>>>,
  );
  const readme = buildReadme(manifest);

  entries.unshift(
    { name: 'manifest.json', input: JSON.stringify(manifest, null, 2) },
    { name: 'data.json', input: JSON.stringify(tableRows, null, 2) },
    { name: 'mistakes.csv', input: mistakesCsv },
    { name: 'review_events.csv', input: reviewEventsCsv },
    { name: 'README.md', input: readme },
  );

  const dateStamp = new Date(exportedAt * 1000).toISOString().slice(0, 10);
  const stream = downloadZip(entries).body as ReadableStream<Uint8Array>;

  return { stream, dateStamp };
}

// ─── Import ────────────────────────────────────────────────────────────────

const INSERT_BATCH_SIZE = 50;
const TEXT_ARRAY_COLUMNS: Partial<Record<TableName, ReadonlySet<string>>> = {
  event: new Set(['affected_scopes']),
};

export interface ImportManifest {
  schema_version: string;
  exported_at: number;
  include_assets: boolean;
  row_counts: Record<string, number>;
  asset_count: number;
}

export type RestoreResult =
  | {
      ok: boolean;
      stats: Record<string, { deleted: number; inserted: number }>;
      assets_uploaded: number;
      assets_failed: number;
      failed_keys: string[];
    }
  | {
      error: string;
      message: string;
      expected?: string;
      got?: string;
      issues?: string[];
      partial_stats?: unknown;
    };

export interface RestoreFromArchiveOpts {
  db: Db;
  r2: R2Client;
  bytes: Uint8Array;
}

function restoreValue(table: TableName, column: string, value: unknown) {
  const isTextArray = TEXT_ARRAY_COLUMNS[table]?.has(column) ?? false;
  if (isTextArray && Array.isArray(value)) {
    if (value.length === 0) return sql`ARRAY[]::text[]`;
    return sql`ARRAY[${sql.join(
      value.map((item) => sql`${item}`),
      sql`,`,
    )}]::text[]`;
  }
  const bound =
    Array.isArray(value) || (value !== null && typeof value === 'object')
      ? JSON.stringify(value)
      : (value ?? null);
  return sql`${bound}`;
}

export async function restoreFromArchive({
  db,
  r2,
  bytes,
}: RestoreFromArchiveOpts): Promise<{ status: number; body: RestoreResult }> {
  if (bytes.byteLength === 0) {
    return {
      status: 400,
      body: { error: 'validation_error', message: 'empty body' },
    };
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 400, body: { error: 'invalid_zip', message: msg } };
  }

  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) {
    return {
      status: 400,
      body: { error: 'invalid_zip', message: 'manifest.json missing from ZIP' },
    };
  }

  let manifest: ImportManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ImportManifest;
  } catch {
    return {
      status: 400,
      body: { error: 'invalid_zip', message: 'manifest.json is not valid JSON' },
    };
  }

  if (manifest.schema_version !== SCHEMA_VERSION) {
    return {
      status: 400,
      body: {
        error: 'schema_version_mismatch',
        expected: SCHEMA_VERSION,
        got: manifest.schema_version,
        message: `schema_version mismatch: expected ${SCHEMA_VERSION}, got ${manifest.schema_version}`,
      },
    };
  }

  const dataBytes = entries['data.json'];
  if (!dataBytes) {
    return {
      status: 400,
      body: { error: 'invalid_zip', message: 'data.json missing from ZIP' },
    };
  }

  let data: Record<string, Array<Record<string, unknown>>>;
  try {
    data = JSON.parse(new TextDecoder().decode(dataBytes)) as Record<
      string,
      Array<Record<string, unknown>>
    >;
  } catch {
    return {
      status: 400,
      body: { error: 'invalid_zip', message: 'data.json is not valid JSON' },
    };
  }

  // `event.ingest_at` is an internal dispatch cursor, not restored memory
  // state. A backup restore starts from an empty memory backend, so restored
  // events must be considered pending for the outbox poller.
  for (const row of data.event ?? []) {
    if (Object.prototype.hasOwnProperty.call(row, 'ingest_at')) {
      row.ingest_at = null;
    }
  }

  // Pre-flight: catch common shape errors BEFORE we wipe the DB.
  const validationErrors: string[] = [];
  for (const t of FK_ORDER) {
    const rows = data[t];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) {
      validationErrors.push(`${t}: not an array`);
      continue;
    }
    if (rows.length === 0) continue;
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
    return {
      status: 400,
      body: {
        error: 'data_validation_failed',
        message: 'Pre-flight validation caught issues; DB was NOT wiped.',
        issues: validationErrors.slice(0, 20),
      },
    };
  }

  const stats: Record<string, { deleted: number; inserted: number }> = {};

  try {
    // Wipe in REVERSE FK order.
    for (const t of [...FK_ORDER].reverse()) {
      await db.execute(sql.raw(`delete from "${t}"`));
      stats[t] = { deleted: 0, inserted: 0 };
    }

    // Insert in FORWARD FK order, chunked.
    for (const t of FK_ORDER) {
      const rows = data[t] ?? [];
      if (rows.length === 0) continue;
      const cols = Object.keys(rows[0]);

      for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
        const chunk = rows.slice(i, i + INSERT_BATCH_SIZE);

        // Build INSERT using drizzle sql template to get proper parameterisation.
        // Arrays and objects must be serialised to JSON strings before binding —
        // drizzle's sql tag treats a bare JS array as a sql.join list which produces
        // "()" for empty arrays, causing a Postgres syntax error. Known Postgres
        // array columns are rebound explicitly in restoreValue().
        const colList = cols.map((c) => `"${c}"`).join(',');
        const rowFragments = chunk.map((row) => {
          const valFragments = cols.map((col) => restoreValue(t, col, row[col] ?? null));
          return sql`(${sql.join(valFragments, sql`,`)})`;
        });
        const query = sql`insert into ${sql.raw(`"${t}"`)} (${sql.raw(colList)}) values ${sql.join(rowFragments, sql`,`)} on conflict do nothing`;
        await db.execute(query);
        stats[t].inserted = (stats[t].inserted ?? 0) + chunk.length;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 500,
      body: {
        error: 'restore_failed_mid_flight',
        message: `DB may be in a half-wiped state. Re-run the same ZIP to retry — wipe is idempotent. ${msg}`,
        partial_stats: stats,
      },
    };
  }

  // Re-PUT assets to R2.
  let assetsUploaded = 0;
  const assetsFailed: string[] = [];
  if (manifest.include_assets) {
    for (const [path, assetBytes] of Object.entries(entries)) {
      if (!path.startsWith('assets/')) continue;
      const key = path.slice('assets/'.length);
      try {
        await r2.put(key, assetBytes);
        assetsUploaded += 1;
      } catch (err) {
        console.error('import: R2 put failed', { key, err });
        assetsFailed.push(key);
      }
    }
  }

  return {
    status: 200,
    body: {
      ok: assetsFailed.length === 0,
      stats,
      assets_uploaded: assetsUploaded,
      assets_failed: assetsFailed.length,
      failed_keys: assetsFailed,
    },
  };
}
