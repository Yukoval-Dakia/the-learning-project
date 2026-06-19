import type { Db, Tx } from '@/db/client';
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
 * have run yet on a fresh DB). to_regclass returns NULL for a missing relation.
 * `table` is bound as a VALUE (not raw-interpolated), so it is injection-safe. */
async function mem0CollectionExists(db: Db | Tx, table: string): Promise<boolean> {
  const rows = (await db.execute(sql`select to_regclass(${`public.${table}`}) as reg`)) as Array<{
    reg: string | null;
  }>;
  return rows[0]?.reg !== null && rows[0]?.reg !== undefined;
}

// A Postgres table/collection name is an IDENTIFIER, not a value — it cannot be a
// parameter bind, so it must reach SQL via sql.raw(). To keep that interpolation
// safe we validate it against the SAME identifier shape mem0's PGVector provider
// enforces on the collectionName (node_modules/mem0ai/dist/oss/index.js
// SAFE_IDENTIFIER_RE / validateIdentifier): letters/digits/underscores, starting
// with a letter or underscore, at most 128 chars. mem0CollectionTable() resolves
// the name from MEM0_PGVECTOR_COLLECTION, so a hostile env value cannot smuggle SQL
// through the raw-interpolated dump query (Cursor OCR minor, PR #491). The validated
// name is double-quote-wrapped at the call sites for the identifier form mem0 uses.
const MEM0_COLLECTION_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;

function assertSafeMem0CollectionName(table: string): void {
  if (!MEM0_COLLECTION_NAME_RE.test(table)) {
    throw new Error(
      `mem0 collection name "${table}" is not a safe SQL identifier (letters/digits/underscores, must start with a letter or underscore, ≤128 chars). Refusing to interpolate it into raw SQL.`,
    );
  }
}

/** Infer the pgvector dimensionality from an archived row's `vector` column. On
 * dump we cast `vector::text`, so an archived vector is the pgvector text form
 * `[a,b,c]` (a string) — its element count IS the declared dim. Returns undefined
 * when the dim cannot be determined (NULL/empty/malformed vector). Used only when a
 * table-absent restore must re-create the collection (mem0 createCol needs a dim);
 * an undeterminable dim there is a hard failure, never a silent skip or wrong dim.
 *
 * WHY first-row inference is sound (Cursor OCR finding, PR #491 — documented-as-
 * intended, NOT a bug): a mem0 pgvector collection is `vector vector(<dims>)` with a
 * SINGLE fixed embedding dimension by construction (mem0 createCol() declares one dim
 * for the whole table, set by the configured embedder). Every row therefore carries an
 * identically-dimensioned vector — Postgres rejects an INSERT of a wrong-length vector
 * into a `vector(<dims>)` column — so the first row's element count equals every row's.
 * There is no per-row dim to scan for; reading row 0 is exact, not a sample/heuristic. */
function inferMem0VectorDims(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return undefined; // `[]` — no elements, no inferable dim
  const dims = inner.split(',').length;
  return dims > 0 ? dims : undefined;
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
  // Identifier safety (Cursor OCR minor, PR #491): the table name is raw-interpolated
  // into the dump SELECT, so validate it against the mem0 collection-name shape before
  // building the query — consistent with the value-bound mem0CollectionExists().
  assertSafeMem0CollectionName(mem0Table);
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

/** Per-column value binder for the mem0 collection INSERT. Driven by column NAME (one
 * of MEM0_COLLECTION_COLUMNS) so the column list and the value fragments stay in
 * lockstep from a single source of truth (no hardcoded ("id","vector","payload")):
 *   - `vector`  → re-parse the dumped `[..]` text back to pgvector via ::vector
 *   - `payload` → bind JSON-stringified object as ::jsonb (NULL/primitive binds plain)
 *   - `id`      → bind plainly (uuid text)
 * A NULL value binds cleanly through any cast (cast of NULL = NULL). */
function mem0RestoreValue(column: string, value: unknown) {
  if (column === 'vector') {
    return sql`${value ?? null}::vector`;
  }
  if (column === 'payload') {
    const bound =
      value !== null && typeof value === 'object' ? JSON.stringify(value) : (value ?? null);
    return sql`${bound}::jsonb`;
  }
  return sql`${value ?? null}`;
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
    // YUK-355 (atomic restore): the ENTIRE restore mutation sequence — FK_ORDER
    // wipe+insert AND the mem0 collection wipe/create/insert — runs inside a SINGLE
    // drizzle transaction. Pre-flight validation (shape/column/unknown-table) already
    // ran ABOVE, outside the tx (validate first, then atomic apply). A failure anywhere
    // in the block throws, drizzle rolls the whole transaction back, and the DB is left
    // exactly as it was — never half-wiped/half-restored. Postgres supports
    // transactional DDL, so the create-extension/create-table for an absent mem0
    // collection roll back cleanly too. All mutations use `tx`, never the outer `db`.
    await db.transaction(async (tx) => {
      // Wipe in REVERSE FK order.
      for (const t of [...FK_ORDER].reverse()) {
        await tx.execute(sql.raw(`delete from "${t}"`));
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
          await tx.execute(query);
          stats[t].inserted = (stats[t].inserted ?? 0) + chunk.length;
        }
      }

      // YUK-355: wipe + restore the mem0 collection (non-FK_ORDER). Restore must make
      // the target collection IDENTICAL to the archived one. We separate two questions:
      //   (i)  Should we PROCESS this collection at all? — yes iff the archive HAS the
      //        mem0 key (mem0Rows is a defined array, even []). An archived [] means
      //        "this collection is empty", so a target that still HAS stale rows must be
      //        WIPED to match. (#491 follow-up: the previous gate `mem0Rows.length > 0`
      //        skipped the WHOLE branch on an empty archive, leaving stale target rows.)
      //   (ii) Are there rows to INSERT / a table to CREATE-if-absent? — only when the
      //        archived array is NON-EMPTY.
      //
      // Cursor Bugbot HIGH (PR #491): when the archive HAS rows but the TARGET lacks the
      // collection table (fresh disaster-recovery DB / mem0 never lazy-init), we RE-CREATE
      // it first, replicating mem0's createCol schema exactly
      // (node_modules/mem0ai/dist/oss/index.js: id UUID PRIMARY KEY, vector vector(<dims>),
      // payload JSONB), inferring <dims> from the first archived row vector (dumped as
      // ::text). If <dims> cannot be determined we FAIL LOUDLY (rolls the tx back) rather
      // than silent-skip or conjure a wrong-dim table.
      //
      // The table-ABSENT + EMPTY-archive case stays a graceful no-op: there is nothing
      // to wipe (no table) and nothing to insert, and mem0's own self-init will create
      // the collection lazily with the live embedder's true dims on first use.
      if (mem0Rows) {
        assertSafeMem0CollectionName(mem0Table);
        const hasRows = mem0Rows.length > 0;
        const tableExists = await mem0CollectionExists(tx, mem0Table);

        // Re-create the collection only when there are rows to land but no table yet.
        if (hasRows && !tableExists) {
          const dims = inferMem0VectorDims(mem0Rows[0]?.vector);
          if (dims === undefined) {
            // Loud failure — surfaced as restore_failed_mid_flight by the outer catch
            // (and rolls the transaction back). We refuse to create a wrong-dim table or
            // silently drop the rows.
            throw new Error(
              `mem0 collection "${mem0Table}" is absent on the target DB and the archived vector dimensionality could not be determined (first row vector is NULL/empty/malformed). Refusing to silently skip backed-up mem0 rows or create a wrong-dim table.`,
            );
          }
          // Replicate mem0 createCol() exactly. CREATE EXTENSION is idempotent; mem0's
          // own initialize() runs it too, but a fresh restore target may not have it yet.
          await tx.execute(sql.raw('create extension if not exists vector'));
          await tx.execute(
            sql.raw(
              `create table if not exists "${mem0Table}" (id uuid primary key, vector vector(${dims}), payload jsonb)`,
            ),
          );
        }

        // The mem0 key IS present in the archive (mem0Rows is defined), so the collection
        // ALWAYS gets a stats entry — hoisted here so it is set on every path, including
        // the empty + table-absent no-op path, where neither the wipe nor the
        // create+insert branch runs (Cursor OCR minor, PR #495: stats[mem0Table] was left
        // undefined there, an inconsistent report for a processed key). The hoist keeps
        // the entry present without conjuring a table or inserting anything (no-op
        // behavior preserved).
        stats[mem0Table] = { deleted: 0, inserted: 0 };

        // WIPE whenever the collection table exists — including the empty-archive case,
        // where wiping is the entire job (target rows → 0 to match the archive). After a
        // create above, `tableExists` was false, so a freshly-created table is already
        // empty (no wipe needed); an existing one (rows OR empty archive) is wiped here.
        // Table-absent + empty-archive is a pure no-op (nothing to wipe, deleted stays 0).
        if (tableExists) {
          await tx.execute(sql.raw(`delete from "${mem0Table}"`));
        }

        if (hasRows) {
          // INSERT column list derived from MEM0_COLLECTION_COLUMNS (single source of
          // truth — same allowlist the pre-flight validates against). Per-column binders
          // apply the right cast: vector::vector re-parses the dumped `[..]` text back to
          // pgvector, payload::jsonb, id binds plainly. NULL binds cleanly (cast of NULL =
          // NULL). Iterating MEM0_COLLECTION_COLUMNS keeps the column list and the value
          // fragments in lockstep — no hardcoded ("id","vector","payload") to drift.
          const orderedCols = [...MEM0_COLLECTION_COLUMNS];
          const colList = orderedCols.map((c) => `"${c}"`).join(',');
          for (let i = 0; i < mem0Rows.length; i += INSERT_BATCH_SIZE) {
            const chunk = mem0Rows.slice(i, i + INSERT_BATCH_SIZE);
            const rowFragments = chunk.map((row) => {
              const valFragments = orderedCols.map((col) =>
                mem0RestoreValue(col, row[col] ?? null),
              );
              return sql`(${sql.join(valFragments, sql`,`)})`;
            });
            // Count ACTUAL inserted rows via RETURNING (Cursor OCR minor, PR #491): with
            // `on conflict do nothing` a duplicate id is skipped, so chunk.length would
            // over-count. The returned row set is exactly the rows that landed.
            const query = sql`insert into ${sql.raw(`"${mem0Table}"`)} (${sql.raw(colList)}) values ${sql.join(
              rowFragments,
              sql`,`,
            )} on conflict do nothing returning "id"`;
            const inserted = (await tx.execute(query)) as Array<{ id: unknown }>;
            stats[mem0Table].inserted += inserted.length;
          }
        }
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // YUK-355 (atomic restore): the whole restore mutation runs inside ONE
    // db.transaction (see above), so a failure here has ALREADY rolled the transaction
    // back — the database is left UNCHANGED, never half-wiped/partially-restored. The
    // message must say so plainly: the previous "DB may be in a half-wiped state" wording
    // predated the transaction wrap and is now FALSE, misleading the operator into
    // thinking their DB is corrupted (Bugbot MEDIUM, PR #495). The error CODE stays
    // `restore_failed_mid_flight` — callers/tests key off it — only the human-facing
    // detail is corrected. `partial_stats` is the stats accumulated before the throw;
    // since the tx rolled back NONE of it was actually applied (left for diagnostics).
    return {
      status: 500,
      body: {
        error: 'restore_failed_mid_flight',
        message: `Restore failed and was rolled back atomically — the database is left UNCHANGED (no partial restore). Fix the cause and re-run the same ZIP. ${msg}`,
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
