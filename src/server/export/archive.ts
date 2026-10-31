/**
 * Build a ZIP of all registered table rows plus optional R2 assets.
 * Restore parses that ZIP, wipes the database, re-inserts the rows, and re-PUTs assets.
 */
import { downloadZip } from 'client-zip';
import { getTableColumns, getTableName, isTable, sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { retireInterventionPreparationJobs as retireArchivedPreparationJobs } from '@/capabilities/agency/public';
import { getConfigSnapshot } from '@/core/config/store';
import { readCompletionContract } from '@/core/event-subscription-effect';
import type { Db, Tx } from '@/db/client';
import * as schema from '@/db/schema';
import type { R2Client } from '@/kernel/object-storage';
import { hydrateConfigFromDb } from '@/server/config/hydrate';
import {
  BACKUP_EXCLUDED_TABLES,
  FK_ORDER,
  MAX_INLINE_ASSETS,
  MEM0_COLLECTION_COLUMNS,
  PAID_EFFECT_BACKUP_TABLES,
  RESTORE_WIPE_ONLY_TABLES,
  SCHEMA_VERSION,
  SUBSCRIPTION_PROGRESS_TABLES,
  type TableName,
  mem0CollectionTable,
} from './constants';
import { buildMistakesCsv, buildReviewEventsCsv } from './csv';
import { type Manifest, buildReadme } from './readme';

// ─── mem0 collection backup ───────────────────────────────────────────────────
//
// mem0's PGVector provider creates its collection table at runtime, so it is absent from
// FK_ORDER and the schema-derived column allowlist. Backing up only the reconciliation log
// would lose the memory bodies, so the collection has a dedicated dump/restore branch keyed
// by the resolved table name. The vector column is dumped as text and bound back as
// ::vector; a missing table means mem0 never initialized and is a graceful no-op.

/** True when the collection table exists; to_regclass returns NULL for a missing relation. */
async function mem0CollectionExists(db: Db | Tx, table: string): Promise<boolean> {
  const rows = (await db.execute(sql`select to_regclass(${`public.${table}`}) as reg`)) as Array<{
    reg: string | null;
  }>;
  return rows[0]?.reg !== null && rows[0]?.reg !== undefined;
}

// A table name is an identifier, not a bind value, so it reaches SQL through sql.raw().
// Validate it with mem0's own identifier shape before interpolation so a hostile env value
// cannot inject SQL.
const MEM0_COLLECTION_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;

function assertSafeMem0CollectionName(table: string): void {
  if (!MEM0_COLLECTION_NAME_RE.test(table)) {
    throw new Error(
      `mem0 collection name "${table}" is not a safe SQL identifier (letters/digits/underscores, must start with a letter or underscore, ≤128 chars). Refusing to interpolate it into raw SQL.`,
    );
  }
}

/** Infer pgvector dimensions from an archived row's `vector` text (`[a,b,c]`). A mem0
 * collection has one fixed dimension by construction, so the first row is exact, not a
 * sample; an undeterminable dim is a hard failure when the table must be re-created. */
function inferMem0VectorDims(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return undefined; // `[]` — no elements, no inferable dim
  const dims = inner.split(',').length;
  return dims > 0 ? dims : undefined;
}

// Restore builds its INSERT column list from data.json keys, which are attacker-controlled.
// Derive the allowlist from the Drizzle schema so column validation cannot drift from the
// schema. Keyed by SQL table name, and every FK_ORDER table is asserted present at load.
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

// Schema-to-coverage assertion: a pgTable missing from both FK_ORDER and
// BACKUP_EXCLUDED_TABLES would silently drop out of the wipe-and-restore payload.
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

  // Event, progress, effects and business parents must describe one committed point.
  // Release the read-only snapshot before fetching external R2 objects/streaming the ZIP.
  await db.transaction(
    async (tx) => {
      for (const t of FK_ORDER) {
        const rows = await tx.execute<Record<string, unknown>>(sql.raw(`select * from "${t}"`));
        tableRows[t] = rows;
        rowCounts[t] = rows.length;
      }

      const mem0Table = mem0CollectionTable();
      assertSafeMem0CollectionName(mem0Table);
      if (await mem0CollectionExists(tx, mem0Table)) {
        const rows = await tx.execute<Record<string, unknown>>(
          sql.raw(`select id, vector::text as vector, payload from "${mem0Table}"`),
        );
        tableRows[mem0Table] = rows;
        rowCounts[mem0Table] = rows.length;
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );

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
  event_subscription_effect: new Set(['mastery_event_ids', 'evidence_ids']),
};

/**
 * Primitive jsonb values arrive from the dump as native scalars; binding them directly
 * makes Postgres reject an integer/text into jsonb. Stringify and cast explicitly.
 */
const JSONB_COLUMNS: Partial<Record<TableName, ReadonlySet<string>>> = {
  system_config: new Set(['value']),
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
      // Set by the allowlist pre-flight (before any wipe).
      table?: string;
      column?: string;
      // Set by the per-row shape barrier.
      index?: number;
      // Set by the downstream-completion pre-flight (before any wipe).
      effects?: UnresolvedEffect[];
      effect_count?: number;
    };

export interface RestoreFromArchiveOpts {
  db: Db;
  r2: R2Client;
  bytes: Uint8Array;
  /**
   * Operational fence for archived intervention preparation jobs. Live restore
   * uses the agency retirer when this is omitted. A disposable database has no
   * archived-runtime pg-boss rows, so that caller sets operationalRestoreTarget
   * instead of inventing a cancellation.
   */
  retireInterventionPreparationJobs?: (tx: Tx, jobIds: string[]) => Promise<void>;
  /**
   * Explicit escape hatch for a newly-created disposable DB whose pg-boss
   * schema cannot contain jobs from the archived runtime.
   */
  operationalRestoreTarget?: 'live' | 'fresh_disposable';
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
  if (JSONB_COLUMNS[table]?.has(column)) {
    // Stringify even primitives: a bare 5 binds as integer and cannot enter jsonb.
    return sql`${value === undefined ? null : JSON.stringify(value)}::jsonb`;
  }
  const bound =
    Array.isArray(value) || (value !== null && typeof value === 'object')
      ? JSON.stringify(value)
      : (value ?? null);
  return sql`${bound}`;
}

/** Per-column binder for the mem0 INSERT, driven by column name so the column list and
 * value fragments stay in sync: vector re-parses text, payload casts to jsonb, id binds
 * plainly. A NULL value casts cleanly. */
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

// event_subscription_effect records that downstream work was reserved or sent to
// pg-boss, not that it completed. The logical ZIP has no pg-boss rows, so an
// unresolved effect cannot be replayed on the target.
const EFFECT_STATUS_WITHOUT_DOWNSTREAM_WORK: ReadonlySet<string> = new Set([
  'debounced',
  'disabled',
]);
const UNRESOLVED_EFFECT_PREVIEW_LIMIT = 20;
// Raw postgres-js exports use a space separator and may abbreviate the UTC offset.
const completionTimestamp = z
  .string()
  .transform((value) => value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))
  .pipe(z.iso.datetime({ offset: true }));

interface UnresolvedEffect {
  id: string | null;
  effect_kind: string | null;
  artifact_id: string | null;
  attempt_event_id: string | null;
  source_event_id: string | null;
  downstream_job_id: string | null;
  status: string | null;
  reason: string;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function unresolvedEffectReason(status: string | null): string {
  switch (status) {
    case 'enqueued':
      return 'downstream job was enqueued under the completion contract but the archive has no completion receipt';
    case 'reserved':
      return 'effect was reserved but never enqueued or completed';
    default:
      return status === null
        ? 'effect has no status or completion receipt'
        : `effect status "${status}" is not terminal and has no completion receipt`;
  }
}

// Only absent contracts are legacy. Old deferred receipts cannot prove completion.
function findUnresolvedEffects(
  rows: ReadonlyArray<Record<string, unknown>> | undefined,
): UnresolvedEffect[] {
  const unresolved: UnresolvedEffect[] = [];
  for (const row of rows ?? []) {
    const status = stringOrNull(row.status);
    const contract = readCompletionContract(row.outcome);
    const settledByStatus = status !== null && EFFECT_STATUS_WITHOUT_DOWNSTREAM_WORK.has(status);
    const hasTimestamp = row.completed_at !== null && row.completed_at !== undefined;
    let reason: string;
    if (contract.kind === 'invalid') {
      reason = 'unknown or malformed completion contract';
    } else if (hasTimestamp && !completionTimestamp.safeParse(row.completed_at).success) {
      reason = 'completed_at must be a valid timestamp';
    } else if (contract.kind === 'v1' && contract.status === 'deferred') {
      reason =
        'deferred patch is not completed and editing_presence is outside the logical archive';
    } else {
      const legacy = contract.kind === 'legacy' && (status === 'enqueued' || status === 'reserved');
      if (settledByStatus || hasTimestamp || legacy) continue;
      reason = unresolvedEffectReason(status);
    }
    unresolved.push({
      id: stringOrNull(row.id),
      effect_kind: stringOrNull(row.effect_kind),
      artifact_id: stringOrNull(row.artifact_id),
      attempt_event_id: stringOrNull(row.attempt_event_id),
      source_event_id: stringOrNull(row.source_event_id),
      downstream_job_id: stringOrNull(row.downstream_job_id),
      status,
      reason,
    });
  }
  return unresolved;
}

export async function restoreFromArchive({
  db,
  r2,
  bytes,
  retireInterventionPreparationJobs,
  operationalRestoreTarget = 'live',
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

  let parsedData: unknown;
  try {
    parsedData = JSON.parse(new TextDecoder().decode(dataBytes));
  } catch {
    return {
      status: 400,
      body: { error: 'invalid_zip', message: 'data.json is not valid JSON' },
    };
  }

  if (typeof parsedData !== 'object' || parsedData === null || Array.isArray(parsedData)) {
    return {
      status: 400,
      body: {
        error: 'invalid_data',
        message: 'data.json must contain a table-keyed object; DB was NOT wiped.',
      },
    };
  }
  const rawData = parsedData as Record<string, unknown>;

  // The mem0 collection key is restored through its dedicated branch, not FK_ORDER.
  const mem0Table = mem0CollectionTable();

  // Pre-flight: reject unknown top-level keys before wiping. Previously they were
  // silently ignored, which could mask a malformed or hostile archive.
  const allowedTables = new Set<string>([...FK_ORDER, mem0Table]);
  for (const key of Object.keys(rawData)) {
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

  // Pre-flight: JSON.parse does not guarantee table arrays or object-shaped rows.
  // Reject malformed rows before column inspection and before the destructive transaction.
  const tableValidationErrors: string[] = [];
  for (const [table, rows] of Object.entries(rawData)) {
    if (!Array.isArray(rows)) {
      tableValidationErrors.push(`${table}: not an array`);
    }
  }
  if (tableValidationErrors.length > 0) {
    return {
      status: 400,
      body: {
        error: 'data_validation_failed',
        message: 'Pre-flight validation caught issues; DB was NOT wiped.',
        issues: tableValidationErrors.slice(0, 20),
      },
    };
  }

  // Table errors take precedence and are reported together; then return the first invalid
  // row with the structured table/index contract import clients expect.
  for (const [table, rows] of Object.entries(rawData)) {
    if (!Array.isArray(rows)) continue;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        return {
          status: 400,
          body: {
            error: 'invalid_row',
            message: `Invalid row at ${table}[${index}]; expected a plain object. DB was NOT wiped.`,
            table,
            index,
          },
        };
      }
    }
  }

  const data = rawData as Record<string, Array<Record<string, unknown>> | undefined>;

  // `event.ingest_at` is an internal dispatch cursor, not restored memory
  // state. A backup restore starts from an empty memory backend, so restored
  // events must be considered pending for the outbox poller.
  for (const row of data.event ?? []) {
    if (Object.hasOwn(row, 'ingest_at')) {
      row.ingest_at = null;
    }
  }
  const archivedInterventionPreparationJobIds = [
    ...new Set(
      (data.intervention ?? [])
        .map((row) => row.preparation_job_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  ];
  // pg-boss rows are operational and absent from the archive. A same-database restore may
  // still hold a live or terminal row with the archived UUID, so never restore that
  // correlation id as current truth. The handler checks its own id at every paid stage;
  // preparing aggregates are picked up with a fresh job UUID, terminal ones need none.
  for (const row of data.intervention ?? []) {
    if (Object.hasOwn(row, 'preparation_job_id')) {
      row.preparation_job_id = null;
    }
  }

  const mem0Rows = data[mem0Table];

  // Pre-flight: validate mem0 column names against the fixed createCol() allowlist
  // before the wipe; these names also reach raw SQL.
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

  // Pre-flight: validate every column name for every table before the wipe. The INSERT
  // interpolates column names via raw SQL, so an unknown name is an injection surface.
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

  // An archive must carry even empty progress tables. Treating a missing key as
  // empty would silently erase its activation history and bootstrap-skip pending work.
  const missingProgress = SUBSCRIPTION_PROGRESS_TABLES.filter((table) => data[table] === undefined);
  if (missingProgress.length > 0) {
    return {
      status: 400,
      body: {
        error: 'data_validation_failed',
        message: 'Subscription progress is missing; DB was NOT wiped.',
        issues: missingProgress.map((table) => `${table}: required progress table missing`),
      },
    };
  }

  // A current-version archive must explicitly carry both durable paid-effect
  // tables, even when empty. Absence cannot mean bootstrap ownership or
  // permission to resend.
  const missingPaidEffects = PAID_EFFECT_BACKUP_TABLES.filter(
    (table) => !Object.hasOwn(data, table),
  );
  if (missingPaidEffects.length > 0) {
    return {
      status: 400,
      body: {
        error: 'data_validation_failed',
        message: 'Paid-effect durability tables are missing; DB was NOT wiped.',
        issues: missingPaidEffects.map((table) => `${table}: required durable table missing`),
      },
    };
  }

  // Pre-flight: catch inconsistent column shapes BEFORE we wipe the DB.
  const columnValidationErrors: string[] = [];
  for (const t of FK_ORDER) {
    const rows = data[t];
    if (rows === undefined) continue;
    if (rows.length === 0) continue;
    const expectedCols = new Set(Object.keys(rows[0]));
    for (let i = 1; i < rows.length; i++) {
      const cols = new Set(Object.keys(rows[i]));
      if (cols.size !== expectedCols.size) {
        columnValidationErrors.push(`${t}[${i}]: column count mismatch`);
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
        columnValidationErrors.push(`${t}[${i}]: missing column ${missing}`);
        break;
      }
    }
  }
  if (columnValidationErrors.length > 0) {
    return {
      status: 400,
      body: {
        error: 'data_validation_failed',
        message: 'Pre-flight validation caught issues; DB was NOT wiped.',
        issues: columnValidationErrors.slice(0, 20),
      },
    };
  }

  // A receipt-bearing effect can record a queue send without a completion receipt; the
  // logical ZIP has no pg-boss rows to recover it. Refuse before the wipe.
  const unresolvedEffects = findUnresolvedEffects(data.event_subscription_effect);
  if (unresolvedEffects.length > 0) {
    return {
      status: 400,
      body: {
        error: 'downstream_completion_unproven',
        message: `Archive has ${unresolvedEffects.length} event-subscription effect(s) whose downstream work is not proven complete; the logical ZIP has no pg-boss job or completion receipt for them. DB was NOT wiped. Use a full PostgreSQL backup when queue state must be recovered.`,
        effect_count: unresolvedEffects.length,
        effects: unresolvedEffects.slice(0, UNRESOLVED_EFFECT_PREVIEW_LIMIT),
      },
    };
  }

  // Preserve existing malformed-table/row/column diagnostics before this new
  // completeness check. Missing creation identity must still reject before any
  // database or memory wipe, even for an exact-version archive.
  if (!Array.isArray(rawData.ingestion_creation_receipt)) {
    return {
      status: 400,
      body: {
        error: 'invalid_data',
        message: 'ingestion_creation_receipt must be present as an array; DB was NOT wiped.',
      },
    };
  }

  const stats: Record<string, { deleted: number; inserted: number }> = {};

  // A strict new epoch must exceed this process's published epoch, or its hydrate guard
  // will reject convergence.
  const localConfigEpoch = getConfigSnapshot().epoch;

  try {
    // The whole restore — table wipe/insert and mem0 wipe/create/insert — runs in one
    // transaction. Pre-flight validation ran above, outside it. Any failure rolls the
    // whole transaction back, so the database is never left half-restored. Postgres
    // transactional DDL also rolls back a created mem0 collection.
    await db.transaction(async (tx) => {
      // Trusted restore channel: SET LOCAL only affects this transaction, letting the
      // immutable assessment guards accept the wipe-and-reinsert. Defer only DEFERRABLE
      // constraints because dump row order does not guarantee parent-first for them;
      // other FKs remain immediate.
      await tx.execute(sql`set local app.assessment_restore_mode = 'on'`);
      await tx.execute(sql`set constraints all deferred`);

      // Capture the pre-wipe epoch axis: the archive restores its own epoch verbatim,
      // but an epoch only means something relative to this DB lineage. Writing a strictly
      // greater epoch below is what makes every hydrate probe notice the restore.
      const preMaxRows = await tx.execute<{ pre_max: number | string }>(sql`
        select greatest(
          coalesce((select max(epoch) from "system_config_epoch"), 0),
          coalesce((select last_value from pg_sequences where schemaname = 'public' and sequencename = 'config_change_seq'), 0),
          ${localConfigEpoch}
        ) as pre_max
      `);
      const preRestoreConfigMax = Math.max(Number(preMaxRows[0]?.pre_max ?? 0), localConfigEpoch);
      if (archivedInterventionPreparationJobIds.length > 0) {
        const retirePreparationJobs =
          retireInterventionPreparationJobs ??
          (operationalRestoreTarget === 'live' ? retireArchivedPreparationJobs : undefined);
        if (retirePreparationJobs) {
          await retirePreparationJobs(tx, archivedInterventionPreparationJobIds);
        } else if (operationalRestoreTarget !== 'fresh_disposable') {
          throw new Error(
            'restore contains intervention preparation job ids but no operational job retirer was provided',
          );
        }
      }

      // Discard excluded process/queue ownership before restoring durable business rows.
      for (const t of RESTORE_WIPE_ONLY_TABLES) {
        await tx.execute(sql.raw(`delete from "${t}"`));
      }

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

          // Build the INSERT with drizzle templates for parameterization. Arrays and objects
          // must be serialized first: a bare JS array becomes a sql.join list and an empty one
          // becomes "()", a syntax error. Known text arrays are rebound in restoreValue().
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

      // Archived leases belong to the source process. Preserve pause/hash, ordering,
      // retry budgets, terminal outcomes, and causal receipts; the temporary claims never
      // become visible outside this transaction.
      await tx.execute(sql`
        update event_subscription_checkpoint
        set claim_owner = null, claim_token = null, claim_lease_until = null
      `);
      await tx.execute(sql`
        update event_subscription_delivery
        set status = case when status = 'claimed' then 'pending' else status end,
            claim_owner = null, claim_token = null, claim_lease_until = null, claimed_at = null
      `);

      // subject_change_seq is not part of the row backup. Without setval, the next control
      // write would draw a stale number and collide with restored as-of coordinates.
      // GREATEST(max, 0)+1 with is_called=false makes nextval return exactly that value;
      // same transaction, so it rolls back atomically.
      await tx.execute(
        sql.raw(
          `select setval('subject_change_seq', (select greatest(coalesce((select max(change_seq) from "subject_trait_journal"), 0), coalesce((select max(change_seq) from "subject_control_journal"), 0)) + 1), false)`,
        ),
      );

      // config_change_seq is also outside the row backup. Without setval, the next config
      // write collides with restored journal coordinates; epoch shares the same sequence,
      // so both advance from the greatest restored value. Same transaction.
      await tx.execute(
        sql.raw(
          `select setval('config_change_seq', (select greatest(coalesce((select max(change_seq) from "system_config_journal"), 0), coalesce((select max(epoch) from "system_config_epoch"), 0)) + 1), false)`,
        ),
      );

      // Never leave the archived epoch verbatim: it came from another timeline and may be
      // equal to or below this process's published epoch, in which case hydrate probes see
      // "unchanged" forever and no process converges. Rewrite it above every epoch this DB
      // lineage has published so the probe must re-hydrate.
      await tx.execute(sql`
        insert into system_config_epoch (id, epoch, updated_at)
        values (
          'global',
          greatest(
            coalesce((select max(epoch) from system_config_epoch), 0),
            ${preRestoreConfigMax}
          ) + 1,
          now()
        )
        on conflict (id) do update
          set epoch = greatest(excluded.epoch, system_config_epoch.epoch + 1),
              updated_at = now()
      `);

      // The setval above stops at the archived high-water mark, but the epoch row was just
      // raised above it. Sync the sequence to the raised epoch so a later bumpEpoch's naked
      // nextval cannot land below it. GREATEST prevents moving backward; sequence operations
      // are not transactional, so a failed restore can only burn numbers, never reuse them.
      await tx.execute(
        sql.raw(
          `select setval('config_change_seq', (select greatest((select epoch from "system_config_epoch" where id = 'global'), (select last_value from pg_sequences where schemaname = 'public' and sequencename = 'config_change_seq'))))`,
        ),
      );

      // event.dispatch_seq is restored verbatim, but event_dispatch_seq is a manual
      // sequence outside row semantics. Without setval the next event collides with the
      // unique constraint. Same in-transaction pattern as subject_change_seq.
      await tx.execute(
        sql.raw(
          `select setval('event_dispatch_seq', (select greatest(coalesce((select max(dispatch_seq) from "event"), 0), 0) + 1), false)`,
        ),
      );

      // mem0 collection wipe + restore (not in FK_ORDER). Two separate questions:
      //   (i) process the collection when the archive HAS the key, even as [] — an empty
      //       archive must wipe stale target rows;
      //   (ii) insert / create the table only when the archived array is non-empty.
      //
      // If the target lacks the table (fresh recovery DB), recreate mem0's createCol()
      // schema exactly and infer dims from the first archived vector. Unknown dims fail
      // loudly and roll back rather than skipping rows or creating a wrong-dim table.
      // Table-absent + empty archive is a graceful no-op; mem0 will lazily create it.
      if (mem0Rows) {
        assertSafeMem0CollectionName(mem0Table);
        const hasRows = mem0Rows.length > 0;
        const tableExists = await mem0CollectionExists(tx, mem0Table);

        // Re-create the collection only when there are rows to land but no table yet.
        if (hasRows && !tableExists) {
          const dims = inferMem0VectorDims(mem0Rows[0]?.vector);
          if (dims === undefined) {
            // Fail loudly (the outer catch rolls back) rather than create a wrong-dim
            // table or silently drop the rows.
            throw new Error(
              `mem0 collection "${mem0Table}" is absent on the target DB and the archived vector dimensionality could not be determined (first row vector is NULL/empty/malformed). Refusing to silently skip backed-up mem0 rows or create a wrong-dim table.`,
            );
          }
          // Replicate mem0 createCol(); the extension create is idempotent.
          await tx.execute(sql.raw('create extension if not exists vector'));
          await tx.execute(
            sql.raw(
              `create table if not exists "${mem0Table}" (id uuid primary key, vector vector(${dims}), payload jsonb)`,
            ),
          );
        }

        // Always report a stats entry for a processed key, including the empty + absent
        // table no-op path.
        stats[mem0Table] = { deleted: 0, inserted: 0 };

        // Wipe whenever the table exists, including an empty archive where wiping is the
        // whole job. A table created above is already empty; absent + empty is a no-op.
        if (tableExists) {
          await tx.execute(sql.raw(`delete from "${mem0Table}"`));
        }

        if (hasRows) {
          // Column list and binders come from MEM0_COLLECTION_COLUMNS so they cannot drift.
          // The same allowlist is used by the pre-flight above.
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
            // Count actual rows via RETURNING: on conflict do nothing skips duplicate ids,
            // so chunk.length would over-count.
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
    // The whole mutation ran in one transaction, so a failure here has already rolled
    // back and the database is unchanged. Keep the error code (callers key off it);
    // partial_stats is diagnostic only. The old "may be half-wiped" wording was false.
    return {
      status: 500,
      body: {
        error: 'restore_failed_mid_flight',
        message: `Restore failed and was rolled back atomically — the database is left UNCHANGED (no partial restore). Fix the cause and re-run the same ZIP. ${msg}`,
        partial_stats: stats,
      },
    };
  }

  // The transaction wrote a strictly newer epoch, so this hydrate must re-read; other
  // processes converge via their refresh.
  await hydrateConfigFromDb(db);

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
