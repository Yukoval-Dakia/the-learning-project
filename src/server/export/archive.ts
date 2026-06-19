import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import type { R2Client } from '@/server/r2';
/**
 * buildBackupArchive — extract all table rows from Postgres + optional R2 assets,
 * then stream a ZIP via client-zip.
 *
 * restoreFromArchive — parse a ZIP produced by buildBackupArchive, wipe the DB,
 * then re-insert all rows + re-PUT R2 assets.
 */
import { downloadZip } from 'client-zip';
import { getTableColumns, getTableName, isTable, sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import {
  BACKUP_EXCLUDED_TABLES,
  FK_ORDER,
  MAX_INLINE_ASSETS,
  MEM0_COLLECTION_COLUMNS,
  SCHEMA_VERSION,
  type TableName,
  mem0CollectionTable,
} from './constants';
import { buildMistakesCsv, buildReviewEventsCsv } from './csv';
import { type Manifest, buildReadme } from './readme';

// ─── mem0 collection backup (YUK-355, D17「数据可丢」推翻续) ────────────────────
//
// The mem0 personalization half stores slow-warming soft-profile memories in a
// pgvector collection table (default `learning_project_memories`) that mem0's
// PGVector provider creates at runtime — NOT a drizzle-managed table, so it is
// absent from FK_ORDER and the schema-derived COLUMN_ALLOWLIST. Backing up only
// memory_reconciliation_log (the WAL/provenance) while dropping the collection
// itself is "备 WAL 不备 collection 是半截" (rethink gate §1.6 / acceptance seam e):
// the memory bodies would vanish on restore. So we dump + restore the collection
// through this dedicated branch, keyed in data.json by the RESOLVED collection
// table name (so a custom MEM0_PGVECTOR_COLLECTION round-trips to the same table).
//
// The `vector` column is pgvector — postgres-js round-trips it as a `[..]` string
// already, but we cast `vector::text` explicitly on dump for stability and bind it
// back with `::vector` on insert. If the table does not exist yet (fresh DB, mem0
// never initialised), dump is skipped (graceful) and restore is a no-op for it.

/** True when the mem0 collection table physically exists (mem0 self-init may not
 * have run yet on a fresh DB). to_regclass returns NULL for a missing relation. */
async function mem0CollectionExists(db: Db, table: string): Promise<boolean> {
  const rows = (await db.execute(sql`select to_regclass(${`public.${table}`}) as reg`)) as Array<{
    reg: string | null;
  }>;
  return rows[0]?.reg != null;
}

// ─── Restore column allowlist (single source of truth: Drizzle schema) ───────
//
// Security (YUK-136): restoreFromArchive builds its INSERT column list from
// Object.keys(rows[0]) — the column names come from the attacker-controlled
// data.json inside the uploaded ZIP — and interpolates them via raw SQL. Without
// validation that is a raw-SQL injection surface through column names. Table
// names are already safe (only FK_ORDER). We derive the allowed column names per
// table from getTableColumns() so the allowlist can never drift from the schema.
//
// Keyed by SQL table name (getTableName), not the JS export identifier, so the
// map is correct even if a future pgTable export is renamed without changing its
// SQL name. Every FK_ORDER table is asserted present at module load.
const COLUMN_ALLOWLIST: Record<TableName, ReadonlySet<string>> = buildColumnAllowlist();

function buildColumnAllowlist(): Record<TableName, ReadonlySet<string>> {
  const fkOrderNames = new Set<string>(FK_ORDER);
  const bySqlName = new Map<string, ReadonlySet<string>>();
  for (const value of Object.values(schema)) {
    if (!isTable(value)) continue;
    const sqlName = getTableName(value);
    if (!fkOrderNames.has(sqlName)) continue;
    const cols = Object.values(getTableColumns(value)).map((c) => c.name);
    bySqlName.set(sqlName, new Set(cols));
  }

  const allowlist = {} as Record<TableName, ReadonlySet<string>>;
  const missing: string[] = [];
  for (const t of FK_ORDER) {
    const cols = bySqlName.get(t);
    if (!cols) {
      missing.push(t);
      continue;
    }
    allowlist[t] = cols;
  }
  if (missing.length > 0) {
    // Lockstep guardrail: FK_ORDER and the Drizzle schema must agree. A missing
    // entry means the constant references a table that has no pgTable export.
    throw new Error(
      `restore column allowlist: no pgTable export found for FK_ORDER table(s): ${missing.join(', ')}`,
    );
  }
  return allowlist;
}

// ─── Reverse lockstep: every pgTable must be covered by the backup ───────────
//
// buildColumnAllowlist() above enforces FK_ORDER → schema (every backed-up table
// has a pgTable export). This is the OTHER direction: schema → coverage. Adding a
// pgTable to src/db/schema.ts but forgetting to wire it into FK_ORDER would make it
// SILENTLY drop out of the wipe-then-restore backup — a data-loss hole no test or
// lint previously caught (②d). Here we assert at module load that EVERY isTable in
// the schema is either backed up (FK_ORDER) or explicitly excluded
// (BACKUP_EXCLUDED_TABLES). pgViews are excluded by isTable (e.g. knowledge_mastery).
assertEveryTableIsBackedUpOrExcluded();

function assertEveryTableIsBackedUpOrExcluded(): void {
  const covered = new Set<string>([...FK_ORDER, ...BACKUP_EXCLUDED_TABLES]);
  const orphans: string[] = [];
  for (const value of Object.values(schema)) {
    if (!isTable(value)) continue;
    const sqlName = getTableName(value);
    if (!covered.has(sqlName)) orphans.push(sqlName);
  }
  if (orphans.length > 0) {
    throw new Error(
      `backup reverse-lockstep: pgTable(s) not covered by the backup payload: ${orphans.join(
        ', ',
      )}. Each new table MUST be added to FK_ORDER (and bump SCHEMA_VERSION) so it is wiped-and-restored, OR added to BACKUP_EXCLUDED_TABLES with a reason if it is transient/derived/operational state. See src/server/export/constants.ts.`,
    );
  }
}

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

  // YUK-355: dump the mem0 collection table (non-drizzle, runtime-created by mem0).
  // Keyed in data.json by its resolved table name. `vector::text` keeps the pgvector
  // column a stable string in JSON. Skipped (no key, count 0) if mem0 never created
  // the table on this DB — a backup of a fresh DB is still valid.
  const mem0Table = mem0CollectionTable();
  if (await mem0CollectionExists(db, mem0Table)) {
    const mem0Rows = (await db.execute(
      sql.raw(`select id, vector::text as vector, payload from "${mem0Table}"`),
    )) as Array<Record<string, unknown>>;
    tableRows[mem0Table] = mem0Rows;
    rowCounts[mem0Table] = mem0Rows.length;
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
      // Set by the YUK-136 pre-flight allowlist rejections (before any wipe).
      table?: string;
      column?: string;
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

  // YUK-355: the mem0 collection key is restorable but NOT in FK_ORDER (it is the
  // resolved collection table name, restored through the dedicated branch below).
  const mem0Table = mem0CollectionTable();
  const mem0Rows = Array.isArray(data[mem0Table]) ? data[mem0Table] : undefined;

  // Pre-flight (security, YUK-136): reject unknown top-level keys BEFORE we wipe
  // the DB. Previously any key in data.json that was not in FK_ORDER was silently
  // ignored; that masks a malformed/hostile archive. Anything outside FK_ORDER
  // (or the mem0 collection key) is a hard 400.
  const allowedTables = new Set<string>([...FK_ORDER, mem0Table]);
  for (const key of Object.keys(data)) {
    if (!allowedTables.has(key)) {
      return {
        status: 400,
        body: {
          error: 'invalid_table',
          message: `Unknown table "${key}" in data.json; DB was NOT wiped.`,
          table: key,
        },
      };
    }
  }

  // Pre-flight (security): validate mem0 collection column names against the fixed
  // mem0 createCol() allowlist (id/vector/payload) BEFORE we wipe — same raw-SQL
  // column-interpolation surface as the FK_ORDER tables below.
  if (mem0Rows) {
    for (const row of mem0Rows) {
      for (const col of Object.keys(row)) {
        if (!MEM0_COLLECTION_COLUMNS.has(col)) {
          return {
            status: 400,
            body: {
              error: 'invalid_column',
              message: `Unknown column "${col}" for mem0 collection "${mem0Table}"; DB was NOT wiped.`,
              table: mem0Table,
              column: col,
            },
          };
        }
      }
    }
  }

  // Pre-flight (security, YUK-136): validate EVERY column name (for every row of
  // every table present in data.json) against the schema-derived allowlist BEFORE
  // we wipe the DB. The restore INSERT interpolates column names via raw SQL, so an
  // unknown column name is a raw-SQL injection surface — reject it as a hard 400.
  for (const t of FK_ORDER) {
    const rows = data[t];
    if (!Array.isArray(rows)) continue;
    const allowed = COLUMN_ALLOWLIST[t];
    for (const row of rows) {
      for (const col of Object.keys(row)) {
        if (!allowed.has(col)) {
          return {
            status: 400,
            body: {
              error: 'invalid_column',
              message: `Unknown column "${col}" for table "${t}"; DB was NOT wiped.`,
              table: t,
              column: col,
            },
          };
        }
      }
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
  // Cursor Bugbot (PR #491): give the mem0 collection entry the SAME present-but-
  // not-an-array shape guard the FK_ORDER tables get above. Without it, a data.json
  // whose mem0 key is PRESENT but malformed (object/string/number rather than an
  // array) collapsed `mem0Rows` to `undefined` at the top of this function —
  // indistinguishable from the legitimate ABSENT case — so NO shape error was
  // raised, the FK_ORDER tables were still wiped + reloaded, and the mem0 collection
  // was SILENTLY skipped (a silent recoverability break: restore must NEVER drop a
  // present-but-malformed table without failing). Mirror FK_ORDER's "not an array"
  // branch: a PRESENT-but-non-array mem0 key is a hard shape error BEFORE any wipe.
  // The ABSENT case (key missing -> fresh DB / mem0 never self-init) stays a graceful
  // skip (mem0Rows === undefined, handled by the dedicated restore branch below).
  if (Object.prototype.hasOwnProperty.call(data, mem0Table) && !Array.isArray(data[mem0Table])) {
    validationErrors.push(`${mem0Table}: not an array`);
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

    // YUK-355: wipe + restore the mem0 collection (non-FK_ORDER). Only acted on
    // when the archive carries the key AND the table physically exists (mem0
    // self-init must have run on this DB — a restore into a DB whose mem0 client
    // has never started would have no table to wipe/insert into; skip gracefully).
    // The `vector` column is bound with an explicit ::vector cast; id/payload reuse
    // the same JSON-serialise-objects discipline as restoreValue().
    if (mem0Rows && (await mem0CollectionExists(db, mem0Table))) {
      stats[mem0Table] = { deleted: 0, inserted: 0 };
      await db.execute(sql.raw(`delete from "${mem0Table}"`));
      for (let i = 0; i < mem0Rows.length; i += INSERT_BATCH_SIZE) {
        const chunk = mem0Rows.slice(i, i + INSERT_BATCH_SIZE);
        const rowFragments = chunk.map((row) => {
          const id = row.id ?? null;
          const vector = row.vector ?? null;
          const payload = row.payload;
          const payloadBound =
            payload !== null && typeof payload === 'object'
              ? JSON.stringify(payload)
              : (payload ?? null);
          // vector::vector casts the dumped `[..]` text back to pgvector; payload
          // is jsonb. NULL vector/payload bind through cleanly (cast of NULL = NULL).
          return sql`(${id}, ${vector}::vector, ${payloadBound}::jsonb)`;
        });
        const query = sql`insert into ${sql.raw(`"${mem0Table}"`)} ("id","vector","payload") values ${sql.join(
          rowFragments,
          sql`,`,
        )} on conflict do nothing`;
        await db.execute(query);
        stats[mem0Table].inserted += chunk.length;
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
