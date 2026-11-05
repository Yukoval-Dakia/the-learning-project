/**
 * Schema write-path drift lint.
 *
 * Every business field in `src/db/schema.ts` must have an INSERT or UPDATE write path.
 * A field with no write path (stub) fails unless the same field was already a stub at
 * the comparison base (`--base` / `CAPABILITY_BASE_SHA` / `TEST_POLICY_BASE`, else
 * merge-base with origin/main) — base measurement is the only grandfathering, there
 * is no allowlist file.
 * The scan also checks the fixed seed-initialization contract for the 0117/0118 registration.
 *
 * Scans .ts/.tsx under src/ and app/.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { listTreeFiles, readBlobs, resolveAuditBaseSha } from './lib/git-base-scan';
import {
  CONTINUATION_COLUMNS,
  RETIRED_SUBAGENT_COLUMNS,
  SUBAGENT_COLUMNS,
  nativeSubagentWriteViolation,
} from './schema-copilot-retention';
import { extractDrizzleWriteIndex, payloadColumns } from './schema-drizzle-producers';
import { extractDatabaseGeneratedWrites, extractExecutedSqlWrites } from './schema-write-producers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCHEMA_PATH = resolve(REPO_ROOT, 'src/db/schema.ts');
const SEARCH_DIRS = ['src', 'app'];
const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git']);

type Field = { table: string; field: string; type: string };
type WriteHit = {
  table: string;
  field: string;
  type: string;
  insert_files: number;
  update_files: number;
  status: 'live' | 'init-only' | 'update-only' | 'stub' | 'historical-retained';
  initialization?: { migration: string; values: readonly string[] };
};

const SESSION_ORPHAN_MIGRATION_TAG = '0117_yuk1394_session_orphan_backend';
const SESSION_ORPHAN_MIGRATION = `drizzle/${SESSION_ORPHAN_MIGRATION_TAG}.sql`;
const MIGRATION_JOURNAL = 'drizzle/meta/_journal.json';
const SESSION_ORPHAN_FAMILIES = [
  'prune_orphan_conversation_sessions',
  'prune_orphan_placement_sessions',
];
// This is an initialization contract for one immutable field, not a migration
// write scanner. Require the complete first executable batch, including its
// closed domain and both seed rows. Comments, function bodies and other SQL
// shapes deliberately fail closed instead of supplying substitute evidence.
const SESSION_ORPHAN_INITIAL_BATCH = `
CREATE TABLE session_orphan_control (
  family text PRIMARY KEY CHECK (family IN ('prune_orphan_conversation_sessions','prune_orphan_placement_sessions')),
  phase text NOT NULL CHECK (phase IN ('pg-boss','draining-pg-boss','dbos','draining-dbos')),
  phase_changed_at timestamptz NOT NULL DEFAULT now(),
  legacy_not_before timestamptz
);
INSERT INTO session_orphan_control (family,phase) VALUES
  ('prune_orphan_conversation_sessions','pg-boss'), ('prune_orphan_placement_sessions','pg-boss');
`;

function sessionOrphanFamilyInitialization(
  schema: string,
  files: ReadonlyMap<string, string>,
): WriteHit['initialization'] {
  const migration = files.get(SESSION_ORPHAN_MIGRATION);
  const journalText = files.get(MIGRATION_JOURNAL);
  if (!migration || !journalText) return undefined;
  let journal: unknown;
  try {
    journal = JSON.parse(journalText);
  } catch {
    return undefined;
  }
  if (
    !isRecord(journal) ||
    journal.version !== '7' ||
    journal.dialect !== 'postgresql' ||
    !Array.isArray(journal.entries)
  )
    return undefined;
  const registrations = journal.entries.filter(
    (entry: unknown) =>
      isRecord(entry) && (entry.idx === 117 || entry.tag === SESSION_ORPHAN_MIGRATION_TAG),
  );
  const registration: unknown = registrations[0];
  if (
    registrations.length !== 1 ||
    !isRecord(registration) ||
    registration.idx !== 117 ||
    registration.tag !== SESSION_ORPHAN_MIGRATION_TAG ||
    registration.version !== '7' ||
    registration.when !== 1791504000001 ||
    registration.breakpoints !== true
  )
    return undefined;
  const firstBatch = migration.split('--> statement-breakpoint')[0];
  const normalizeSql = (text: string) => text.trim().replace(/\s+/g, ' ');
  if (normalizeSql(firstBatch) !== normalizeSql(SESSION_ORPHAN_INITIAL_BATCH)) return undefined;

  const file = ts.createSourceFile('schema.ts', schema, ts.ScriptTarget.Latest, true);
  const declarations = file.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? [...statement.declarationList.declarations].filter(
          (declaration) =>
            ts.isIdentifier(declaration.name) && declaration.name.text === 'session_orphan_control',
        )
      : [],
  );
  const table = declarations[0]?.initializer;
  if (
    declarations.length !== 1 ||
    !table ||
    !ts.isCallExpression(table) ||
    !ts.isIdentifier(table.expression) ||
    table.expression.text !== 'pgTable'
  )
    return undefined;
  const [name, columns] = table.arguments;
  if (
    !name ||
    !ts.isStringLiteral(name) ||
    name.text !== 'session_orphan_control' ||
    !columns ||
    !ts.isObjectLiteralExpression(columns) ||
    !columns.properties.every(ts.isPropertyAssignment)
  )
    return undefined;
  const family = columns.properties.filter(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'family',
  );
  const column = family[0];
  // Ignore layout without erasing whitespace inside the declared string values.
  const columnTokens = (source: string) => {
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      true,
      ts.LanguageVariant.Standard,
      source,
    );
    const tokens: string[] = [];
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
    return tokens.join('\n');
  };
  if (
    family.length !== 1 ||
    !column ||
    !ts.isPropertyAssignment(column) ||
    columnTokens(column.initializer.getText(file)) !==
      columnTokens(
        "text('family',{enum:['prune_orphan_conversation_sessions','prune_orphan_placement_sessions'],}).primaryKey()",
      )
  )
    return undefined;
  return { migration: SESSION_ORPHAN_MIGRATION, values: SESSION_ORPHAN_FAMILIES };
}

const JUDGE_CONTROL_MIGRATION_TAG = '0118_yuk1356_judge_durable';
const JUDGE_CONTROL_MIGRATION = `drizzle/${JUDGE_CONTROL_MIGRATION_TAG}.sql`;
const JUDGE_CONTROL_INITIAL_BATCH = `
CREATE TABLE judge_run_control (
  id smallint PRIMARY KEY CONSTRAINT judge_run_control_singleton CHECK (id = 1),
  incarnation uuid NOT NULL,
  epoch bigint NOT NULL CONSTRAINT judge_run_control_epoch CHECK (epoch >= 0),
  phase text NOT NULL CONSTRAINT judge_run_control_phase CHECK (phase IN ('pg-boss','draining-pg-boss','dbos','draining-dbos')),
  phase_changed_at timestamptz NOT NULL,
  transition_event_id text
);
INSERT INTO judge_run_control VALUES (1, gen_random_uuid(), 0, 'pg-boss', clock_timestamp(), NULL);
`;
const JUDGE_CONTROL_DECLARATION = `pgTable(
  'judge_run_control',
  {
    id: smallint('id').primaryKey(),
    incarnation: uuid('incarnation').notNull(),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    phase: text('phase').notNull(),
    phase_changed_at: timestamp('phase_changed_at', { withTimezone: true }).notNull(),
    transition_event_id: text('transition_event_id'),
  },
  (t) => [
    check('judge_run_control_singleton', sql\`\${t.id} = 1\`),
    check('judge_run_control_epoch', sql\`\${t.epoch} >= 0\`),
    check(
      'judge_run_control_phase',
      sql\`\${t.phase} IN ('pg-boss','draining-pg-boss','dbos','draining-dbos')\`,
    ),
  ],
)`;
// Pin only this migration's remaining receipt/index/fence batches. A later
// appended control mutation cannot borrow the first batch's initialization proof.
const JUDGE_CONTROL_REMAINDER_SHA256 =
  '2ba58ae37dc6b8b12d4e21cfd53966b5af8cb34b920bad221bb88d4a874adc55';
const normalizeJudgeSql = (source: string) => source.trim().replace(/\s+/g, ' ');
function judgeDeclarationTokens(source: string) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const tokens: string[] = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  return tokens.join('\n');
}
function judgeControlIncarnationInitialization(
  schema: string,
  files: ReadonlyMap<string, string>,
): WriteHit['initialization'] {
  const migration = files.get(JUDGE_CONTROL_MIGRATION);
  const journalText = files.get(MIGRATION_JOURNAL);
  if (!migration || !journalText) return undefined;
  let journal: unknown;
  try {
    journal = JSON.parse(journalText);
  } catch {
    return undefined;
  }
  if (
    !isRecord(journal) ||
    journal.version !== '7' ||
    journal.dialect !== 'postgresql' ||
    !Array.isArray(journal.entries)
  )
    return undefined;
  const registrations = journal.entries.filter(
    (entry: unknown) =>
      isRecord(entry) && (entry.idx === 118 || entry.tag === JUDGE_CONTROL_MIGRATION_TAG),
  );
  const registration: unknown = registrations[0];
  if (
    registrations.length !== 1 ||
    !isRecord(registration) ||
    registration.idx !== 118 ||
    registration.tag !== JUDGE_CONTROL_MIGRATION_TAG ||
    registration.version !== '7' ||
    registration.when !== 1791504000002 ||
    registration.breakpoints !== true
  )
    return undefined;
  const breakpoint = migration.indexOf('--> statement-breakpoint');
  if (
    breakpoint < 0 ||
    normalizeJudgeSql(migration.slice(0, breakpoint)) !==
      normalizeJudgeSql(JUDGE_CONTROL_INITIAL_BATCH) ||
    createHash('sha256')
      .update(normalizeJudgeSql(migration.slice(breakpoint + '--> statement-breakpoint'.length)))
      .digest('hex') !== JUDGE_CONTROL_REMAINDER_SHA256
  )
    return undefined;
  const file = ts.createSourceFile('schema.ts', schema, ts.ScriptTarget.Latest, true);
  const declarations = file.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) &&
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ? [...statement.declarationList.declarations].filter((declaration) => {
          const table = declaration.initializer;
          return (
            (ts.isIdentifier(declaration.name) && declaration.name.text === 'judge_run_control') ||
            (table &&
              ts.isCallExpression(table) &&
              ts.isIdentifier(table.expression) &&
              table.expression.text === 'pgTable' &&
              table.arguments[0] &&
              ts.isStringLiteral(table.arguments[0]) &&
              table.arguments[0].text === 'judge_run_control')
          );
        })
      : [],
  );
  const declaration = declarations[0];
  if (
    declarations.length !== 1 ||
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    declaration.name.text !== 'judge_run_control' ||
    !declaration.initializer ||
    judgeDeclarationTokens(declaration.initializer.getText(file)) !==
      judgeDeclarationTokens(JUDGE_CONTROL_DECLARATION)
  )
    return undefined;
  return { migration: JUDGE_CONTROL_MIGRATION, values: ['gen_random_uuid()'] };
}

type JudgeInitializationIssue =
  | { code: 'invalid_initialization'; message: string }
  | { code: 'production_write'; path: string; kind: WriteStatement['kind']; message: string };
function isMutableJudgeControlPatch(payload: string): boolean {
  const file = ts.createSourceFile(
    'control-patch.ts',
    `const patch = ${payload}`,
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = file.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) return false;
  const patch = statement.declarationList.declarations[0]?.initializer;
  if (!patch || !ts.isObjectLiteralExpression(patch) || patch.properties.length === 0) return false;
  const mutableColumns = new Set(['epoch', 'phase', 'phase_changed_at', 'transition_event_id']);
  return patch.properties.every(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      mutableColumns.has(property.name.text),
  );
}
function judgeControlWriteIssues(index: Map<string, WriteStatement[]>): JudgeInitializationIssue[] {
  return [...index].flatMap(([path, statements]) =>
    statements.flatMap((statement): JudgeInitializationIssue[] => {
      if (statement.table !== 'judge_run_control') return [];
      if (
        statement.kind === 'update' &&
        statement.explicitPayload === true &&
        isMutableJudgeControlPatch(statement.payload)
      )
        return [];
      return [
        {
          code: 'production_write',
          path,
          kind: statement.kind,
          message:
            'judge_run_control is initialized only by 0118; production updates must explicitly preserve id and incarnation',
        },
      ];
    }),
  );
}

// ADR-0058 intentionally retired this writer, not its historical schema. This fixed inventory is
// a retention contract, never a dated allowance.
const HISTORICAL_TABLE = 'copilot_evidence_checkpoint';
const HISTORICAL_COLUMNS: Readonly<Record<string, string>> = {
  id: 'text',
  task_kind: 'text',
  slot: 'text',
  protocol_version: 'integer',
  prompt_fingerprint: 'text',
  base_input_sha256: 'text',
  source_catalog_sha256: 'text',
  binding_extras: 'jsonb',
  status: 'text',
  revision: 'integer',
  records_json: 'jsonb',
  record_digests_json: 'jsonb',
  attempts_json: 'jsonb',
  sealed_output_json: 'jsonb',
  sealed_digest_sha256: 'text',
  sealed_task_run_id: 'text',
  created_at: 'timestamp with time zone',
  updated_at: 'timestamp with time zone',
  expires_at: 'timestamp with time zone',
};
type HistoricalRetentionIssue =
  | {
      code: 'missing_table' | 'missing_column' | 'added_column' | 'changed_column_type';
      message: string;
    }
  | { code: 'production_write'; kind: WriteStatement['kind']; path: string; message: string };
type HistoricalRetention = {
  table: string;
  reason: string;
  fields: Field[];
  issues: HistoricalRetentionIssue[];
};

/** Narrow inventory check including columns the business-field regex cannot parse. */
function historicalRetention(
  schema: string,
  productionIndex: ReadonlyMap<string, WriteStatement[]>,
  table = HISTORICAL_TABLE,
  columns = HISTORICAL_COLUMNS,
  reason = 'ADR-0058 / YUK-939 retired Copilot evidence checkpoint writers; retain historical rows/schema and export/restore compatibility. Production INSERT/UPDATE is forbidden.',
): HistoricalRetention {
  const fields: Field[] = [];
  const issues: HistoricalRetentionIssue[] = [];
  let found = false;
  const file = ts.createSourceFile('schema.ts', schema, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'pgTable'
    ) {
      const [name, columns] = node.arguments;
      if (name && ts.isStringLiteral(name) && name.text === table) {
        found = true;
        if (columns && ts.isObjectLiteralExpression(columns)) {
          for (const column of columns.properties) {
            if (!ts.isPropertyAssignment(column)) {
              issues.push({
                code: 'added_column',
                message: 'Historical columns must remain explicit property assignments',
              });
              continue;
            }
            let builder = column.initializer;
            while (
              ts.isCallExpression(builder) &&
              ts.isPropertyAccessExpression(builder.expression)
            ) {
              builder = builder.expression.expression;
            }
            const columnName = ts.isCallExpression(builder) ? builder.arguments[0] : undefined;
            const field =
              columnName && ts.isStringLiteral(columnName)
                ? columnName.text
                : column.name.getText(file);
            let type =
              columnName &&
              ts.isStringLiteral(columnName) &&
              ts.isCallExpression(builder) &&
              ts.isIdentifier(builder.expression)
                ? builder.expression.text
                : 'unrecognized';
            if (type === 'timestamp' && ts.isCallExpression(builder)) {
              const options = builder.arguments[1];
              const timezone =
                options && ts.isObjectLiteralExpression(options)
                  ? options.properties.find(
                      (option) =>
                        ts.isPropertyAssignment(option) &&
                        option.name.getText(file) === 'withTimezone',
                    )
                  : undefined;
              if (
                timezone &&
                ts.isPropertyAssignment(timezone) &&
                timezone.initializer.kind === ts.SyntaxKind.TrueKeyword
              )
                type = 'timestamp with time zone';
            }
            fields.push({ table, field, type });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!found) issues.push({ code: 'missing_table', message: `${table} must remain in schema` });
  for (const [field, type] of Object.entries(columns)) {
    const actual = fields.filter((column) => column.field === field);
    if (!actual.length)
      issues.push({
        code: 'missing_column',
        message: `${table}.${field} (${type}) must remain`,
      });
    for (const column of actual) {
      if (column.type !== type)
        issues.push({
          code: 'changed_column_type',
          message: `${table}.${field}: expected ${type}, found ${column.type}`,
        });
    }
    if (actual.length > 1)
      issues.push({ code: 'added_column', message: `${table}.${field} is duplicated` });
  }
  for (const column of fields) {
    if (!Object.hasOwn(columns, column.field))
      issues.push({
        code: 'added_column',
        message: `${table}.${column.field} (${column.type}) is outside the retained inventory`,
      });
  }
  // Count table targets before adding schema-generated defaults. A forbidden
  // write needs no recognized payload columns, including trivial-only writes.
  for (const [path, statements] of productionIndex) {
    for (const statement of statements) {
      if (statement.table !== table) continue;
      const violation =
        table === 'subagent_run' ? nativeSubagentWriteViolation(statement) : 'retired table';
      if (violation)
        issues.push({
          code: 'production_write',
          kind: statement.kind,
          path,
          message: `${path}: ${statement.kind.toUpperCase()} targets ${table}: ${violation}`,
        });
    }
  }
  return {
    table,
    reason,
    fields,
    issues,
  };
}

// YUK-1113: retire only the unimplemented timestamp producer, never the stored column.
// This is a fixed column contract in an otherwise live table, not a dated exemption.
function pausedCheckpointRetention(
  schema: string,
  productionIndex: ReadonlyMap<string, WriteStatement[]>,
): HistoricalRetention {
  const table = 'event_subscription_checkpoint';
  const field = 'paused_at';
  const issues: HistoricalRetentionIssue[] = [];
  const file = ts.createSourceFile('schema.ts', schema, ts.ScriptTarget.Latest, true);
  const tables: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'pgTable' &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === table
    )
      tables.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const columns = tables[0]?.arguments[1];
  const properties = columns && ts.isObjectLiteralExpression(columns) ? columns.properties : [];
  const retained = properties.filter(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === field,
  );
  const sqlColumns = properties.filter((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    let builder = property.initializer;
    while (ts.isCallExpression(builder) && ts.isPropertyAccessExpression(builder.expression))
      builder = builder.expression.expression;
    const name = ts.isCallExpression(builder) ? builder.arguments[0] : undefined;
    return name && ts.isStringLiteral(name) && name.text === field;
  });
  const declaration = retained[0];
  const initializer =
    declaration && ts.isPropertyAssignment(declaration) ? declaration.initializer : undefined;
  // An unchained constructor pins nullable/no-default behavior as well as the SQL name/type.
  const args = initializer && ts.isCallExpression(initializer) ? initializer.arguments : [];
  const options = args[1];
  const timezone =
    options && ts.isObjectLiteralExpression(options) ? options.properties[0] : undefined;
  if (
    tables.length !== 1 ||
    !columns ||
    !ts.isObjectLiteralExpression(columns) ||
    !properties.every(ts.isPropertyAssignment) ||
    retained.length !== 1 ||
    sqlColumns.length !== 1 ||
    !initializer ||
    !ts.isCallExpression(initializer) ||
    !ts.isIdentifier(initializer.expression) ||
    initializer.expression.text !== 'timestamp' ||
    args.length !== 2 ||
    !ts.isStringLiteral(args[0]) ||
    args[0].text !== field ||
    !options ||
    !ts.isObjectLiteralExpression(options) ||
    options.properties.length !== 1 ||
    !timezone ||
    !ts.isPropertyAssignment(timezone) ||
    !ts.isIdentifier(timezone.name) ||
    timezone.name.text !== 'withTimezone' ||
    timezone.initializer.kind !== ts.SyntaxKind.TrueKeyword
  )
    issues.push({
      code: 'changed_column_type',
      message: `${table}.${field} must remain an explicit nullable timestamp with timezone and no default`,
    });
  for (const [path, statements] of productionIndex) {
    for (const statement of statements) {
      if (statement.table !== table) continue;
      const columns = payloadColumns(statement.payload);
      const payloadFile = ts.createSourceFile(
        'payload.ts',
        `const payload = ${statement.payload}`,
        ts.ScriptTarget.Latest,
        true,
      );
      const first = payloadFile.statements[0];
      const payload =
        first && ts.isVariableStatement(first)
          ? first.declarationList.declarations[0]?.initializer
          : undefined;
      const inspectable =
        payload &&
        ts.isObjectLiteralExpression(payload) &&
        payload.properties.every(
          (property) =>
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)),
        );
      // No source path (including archive.ts) exempts an explicit write to this field.
      // Opaque Drizzle payloads or column-less SQL cannot prove they preserve it.
      if (
        !inspectable ||
        statement.explicitPayload === false ||
        columns.size === 0 ||
        columns.has(field)
      )
        issues.push({
          code: 'production_write',
          kind: statement.kind,
          path,
          message: `${path}: ${statement.kind.toUpperCase()} must preserve historical ${table}.${field}`,
        });
    }
  }
  return {
    table,
    reason:
      'YUK-1113 retains paused_at for historical SQL and archive compatibility only; no business timestamp producer. Other checkpoint columns remain live and normally audited.',
    fields: [{ table, field, type: 'timestamp with time zone' }],
    issues,
  };
}

export function formatHistoricalRetention(retention: HistoricalRetention): string {
  return [
    `Historical retention: ${retention.table} (${retention.fields.length} columns)`,
    retention.reason,
    ...retention.fields.map((field) => `  ${field.table}.${field.field}: ${field.type}`),
    ...retention.issues.map((issue) => `  ${issue.code}: ${issue.message}`),
  ].join('\n');
}

const TRIVIAL_FIELDS = new Set(['id', 'created_at', 'updated_at', 'version', 'archived_at']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Drizzle column constructors recognised by parseSchema. The first group are native
// drizzle-orm/pg-core builders; `vector` is the project customType without which
// `embedding: vector(1024)` columns escape parsing. Add future project customType names here so
// their columns are audited automatically.
const PROJECT_CUSTOM_TYPE_CONSTRUCTORS = ['vector'] as const;
const SCHEMA_CONSTRAINT_HELPERS = new Set(['check', 'primaryKey', 'unique', 'index', 'foreignKey']);
const NATIVE_COLUMN_CONSTRUCTORS = [
  'text',
  'integer',
  'real',
  'doublePrecision',
  'jsonb',
  'boolean',
  'timestamp',
  'smallint',
  'bigint',
  'date',
  'numeric',
  'varchar',
  'json',
  'uuid',
  'bytea',
  'check',
  'primaryKey',
  'unique',
  'index',
  'foreignKey',
];
const COLUMN_CONSTRUCTOR_RE = new RegExp(
  `^\\s{2,4}(\\w+):\\s+(${[...NATIVE_COLUMN_CONSTRUCTORS, ...PROJECT_CUSTOM_TYPE_CONSTRUCTORS].join('|')})\\(`,
  'gm',
);

export function parseSchema(src: string): Field[] {
  const fields: Field[] = [];
  // Find pgTable entry points so we can slice per-table blocks.
  const tableHeads = [...src.matchAll(/export const (\w+) = pgTable\(\s*'(\w+)'/g)];
  // Also find pgView so a per-table block stops at the next entity boundary
  // (otherwise view columns get misattributed to the preceding pgTable).
  const viewHeads = [...src.matchAll(/export const (\w+) = pgView\(\s*'(\w+)'/g)];
  // Sorted union of all entity-start offsets — block boundaries.
  const boundaries = [...tableHeads, ...viewHeads].map((m) => m.index ?? 0).sort((a, b) => a - b);
  for (let i = 0; i < tableHeads.length; i++) {
    const tableName = tableHeads[i][2];
    const start = tableHeads[i].index ?? 0;
    // End at the next entity boundary (pgTable or pgView) — whichever comes first.
    const next = boundaries.find((b) => b > start);
    const end = next ?? src.length;
    const block = src.slice(start, end);
    // `lastIndex` carries between matchAll iterations on a shared /g RegExp; reset per block.
    COLUMN_CONSTRUCTOR_RE.lastIndex = 0;
    const fieldMatches = block.matchAll(COLUMN_CONSTRUCTOR_RE);
    for (const m of fieldMatches) {
      // Skip schema constraint helpers.
      if (SCHEMA_CONSTRAINT_HELPERS.has(m[2])) continue;
      fields.push({ table: tableName, field: m[1], type: m[2] });
    }
  }
  return fields;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      walkFiles(p, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

// A single drizzle write statement, scoped to the table it targets. `kind` distinguishes INSERT
// from UPDATE; `payload` is a direct object literal or the top-level keys proved by bounded AST
// tracing. Matching reads top-level syntax keys only, confined to this statement: the old
// file-level matcher ignored table identity and let a write to `mistake_variant.parent_question_id`
// satisfy `question.parent_question_id`.
export type WriteStatement = {
  kind: 'insert' | 'update';
  table: string;
  payload: string;
  explicitPayload?: boolean;
  statusValues?: readonly string[];
  nativeStartedAt?: boolean;
};

/** Paths are repository-relative; fixture/rehearsal writes cannot satisfy a production column. */
export function isProductionSource(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return (
    !/(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__|__mocks__|rehearsal)(?:\/|$)/.test(
      normalized,
    ) &&
    !/(?:^|[./_-])(?:test|spec|fixtures?|rehearsal)(?:[.-]|$)/.test(normalized) &&
    !/(?:^|\/)(?:schema|.*generated)\.tsx?$/.test(normalized) &&
    !normalized.endsWith('.d.ts')
  );
}

export function extractWriteStatements(source: string): WriteStatement[] {
  return extractDrizzleWriteIndex(new Map([['runtime.ts', source]])).get('runtime.ts') ?? [];
}

/** Keep quoted checkpoint writes visible without broadening the general producer scanner. */
function quotedCheckpointWrites(source: string): WriteStatement[] {
  const file = ts.createSourceFile(
    'source.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const writes: WriteStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'execute'
    ) {
      const arg = node.arguments[0];
      if (
        arg &&
        ts.isTaggedTemplateExpression(arg) &&
        ts.isIdentifier(arg.tag) &&
        arg.tag.text === 'sql'
      ) {
        const template = arg.template;
        const raw = ts.isNoSubstitutionTemplateLiteral(template)
          ? template.text
          : template.head.text +
            template.templateSpans.map((span) => ` ? ${span.literal.text}`).join('');
        // Single-quoted values/comments stay inert. Double-quoted SQL identifiers are syntax.
        // PostgreSQL folds unquoted identifiers to lowercase; quoted ones keep their case.
        const sql = raw
          .replace(
            /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|\$([a-z_][\w]*|)\$[\s\S]*?\$\1\$/gi,
            ' ',
          )
          .replace(/"(?:""|[^"])*"|[^"]+/g, (part) =>
            part.startsWith('"') ? part : part.toLowerCase(),
          )
          .replace(/"([a-z_][\w]*)"/gi, '$1');
        if (
          /\b(?:insert\s+into|update)\s+(?:public\.)?event_subscription_checkpoint\b/i.test(sql)
        ) {
          // Parse through the existing executed-SQL scanner after identifier normalization.
          // JSON stringification is not used: a template literal must preserve SQL backticks safely.
          const normalized = sql
            .replace(/`/g, ' ')
            .replace(/\$\{/g, ' ')
            .replace(
              /\bpublic\.event_subscription_checkpoint\b/gi,
              'event_subscription_checkpoint',
            );
          // The producer scanner erases tuple LHS columns. Its remaining scalar
          // columns cannot prove that this statement preserves the retained field.
          if (/(?:\bset|,)\s*\([^()]*\)\s*=/i.test(normalized)) {
            writes.push({
              kind: 'update',
              table: 'event_subscription_checkpoint',
              payload: '{}',
              explicitPayload: false,
            });
          }
          writes.push(
            ...extractExecutedSqlWrites(`db.execute(sql\`${normalized}\`);`).filter(
              (write) => write.table === 'event_subscription_checkpoint',
            ),
          );
          // INSERT's column list does not describe its ON CONFLICT update branch.
          // Keep that branch visible, including null/default writes and opaque assignments.
          for (const conflict of normalized.matchAll(
            /\bon\s+conflict\b[^;]*?\bdo\s+update\s+set\s+([^;]*)/gi,
          )) {
            const updates = extractExecutedSqlWrites(
              `db.execute(sql\`update event_subscription_checkpoint set ${conflict[1]}\`);`,
            );
            writes.push(...updates);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return writes;
}

export function buildProductionWriteIndex(
  sources: ReadonlyMap<string, string>,
): Map<string, WriteStatement[]> {
  const production = new Map([...sources].filter(([path]) => isProductionSource(path)));
  const index = extractDrizzleWriteIndex(
    production,
    new Set(['subagent_run', 'judge_run_control', 'event_subscription_checkpoint']),
  );
  for (const [path, source] of production) {
    index.set(path, [
      ...(index.get(path) ?? []),
      ...extractExecutedSqlWrites(source),
      ...quotedCheckpointWrites(source),
    ]);
  }
  return index;
}

function statementMatchesField(payload: string, field: string): boolean {
  return payloadColumns(payload).has(field);
}

// Table-aware write-path count. A field counts as written only when a statement targeting its own
// table carries it, so a same-named column on another table cannot cross-satisfy. Counts are
// per-file.
export function countWriteHits(
  table: string,
  field: string,
  index: Map<string, WriteStatement[]>,
): { insert_files: number; update_files: number } {
  let insertFiles = 0;
  let updateFiles = 0;
  for (const [, statements] of index) {
    let fileInsert = false;
    let fileUpdate = false;
    for (const st of statements) {
      if (st.table !== table) continue;
      if (!statementMatchesField(st.payload, field)) continue;
      if (st.kind === 'insert') fileInsert = true;
      else fileUpdate = true;
    }
    if (fileInsert) insertFiles++;
    if (fileUpdate) updateFiles++;
  }
  return { insert_files: insertFiles, update_files: updateFiles };
}

export function auditSchemaWrites(
  schema: string,
  sources: ReadonlyMap<string, string>,
  initializationFiles: ReadonlyMap<string, string> = new Map(),
) {
  const index = buildProductionWriteIndex(sources);
  const familyInitialization = sessionOrphanFamilyInitialization(schema, initializationFiles);
  const incarnationInitialization = judgeControlIncarnationInitialization(
    schema,
    initializationFiles,
  );
  const judgeInitializationIssues: JudgeInitializationIssue[] = judgeControlWriteIssues(index);
  if (!incarnationInitialization)
    judgeInitializationIssues.unshift({
      code: 'invalid_initialization',
      message:
        'judge_run_control.incarnation requires the exact Drizzle declaration and uniquely registered 0118 singleton initializer',
    });
  const retention = historicalRetention(schema, index);
  const retainedSchemas = [
    retention,
    pausedCheckpointRetention(schema, index),
    historicalRetention(
      schema,
      index,
      'copilot_continuation',
      CONTINUATION_COLUMNS,
      'ADR-0063 / YUK-951 B3 retains continuation schema and installation drain history. Production INSERT/UPDATE is forbidden; no current producer or worker.',
    ),
    historicalRetention(
      schema,
      index,
      'subagent_run',
      SUBAGENT_COLUMNS,
      'ADR-0063 / ADR-0065 retains the native child projection and historical mailbox fields. Retired ownership writes are forbidden; explicit native lifecycle writes and null lease cleanup remain permitted.',
    ),
  ];
  const retainedHits = retainedSchemas
    .flatMap((contract) => contract.fields)
    .filter((field) => field.table !== 'subagent_run' || RETIRED_SUBAGENT_COLUMNS.has(field.field))
    .map((field) => ({
      ...field,
      ...countWriteHits(field.table, field.field, index),
    }));
  // Defaults remain valid business-field evidence, but cannot resurrect a
  // retired production writer or violate historical retention.
  index.set(SCHEMA_PATH, extractDatabaseGeneratedWrites(schema));
  const results: WriteHit[] = [];
  for (const f of parseSchema(schema)) {
    if (
      (f.table === 'event_subscription_checkpoint' && f.field === 'paused_at') ||
      f.table === HISTORICAL_TABLE ||
      f.table === 'copilot_continuation' ||
      (f.table === 'subagent_run' && RETIRED_SUBAGENT_COLUMNS.has(f.field)) ||
      TRIVIAL_FIELDS.has(f.field)
    )
      continue;
    const { insert_files, update_files } = countWriteHits(f.table, f.field, index);
    const initialization =
      f.table === 'session_orphan_control' && f.field === 'family'
        ? familyInitialization
        : f.table === 'judge_run_control' &&
            f.field === 'incarnation' &&
            judgeInitializationIssues.length === 0
          ? incarnationInitialization
          : undefined;
    let status: WriteHit['status'];
    if (f.table === 'judge_run_control' && f.field === 'incarnation')
      status = initialization ? 'init-only' : 'stub';
    else if (insert_files > 0 && update_files > 0) status = 'live';
    else if (insert_files > 0) status = 'init-only';
    else if (update_files > 0) status = 'update-only';
    else if (initialization) status = 'init-only';
    else status = 'stub';
    results.push({
      ...f,
      insert_files,
      update_files,
      status,
      ...(initialization ? { initialization } : {}),
    });
  }
  for (const field of retainedHits) {
    // Report retained columns including trivial identifiers and timestamps.
    // Mixed native columns retain their ordinary production classification.
    results.push({ ...field, status: 'historical-retained' });
  }
  return { results, historicalRetention: retention, retainedSchemas, judgeInitializationIssues };
}

export function audit(repoRoot = REPO_ROOT) {
  const files: string[] = [];
  for (const d of SEARCH_DIRS) walkFiles(resolve(repoRoot, d), files);
  return auditSchemaWrites(
    readSchemaAggregate(repoRoot),
    new Map(
      files.map((path) => [
        relative(repoRoot, path).replaceAll('\\', '/'),
        readFileSync(path, 'utf8'),
      ]),
    ),
    new Map(
      [MIGRATION_JOURNAL, SESSION_ORPHAN_MIGRATION, JUDGE_CONTROL_MIGRATION].flatMap((path) => {
        const absolute = resolve(repoRoot, path);
        return existsSync(absolute) ? [[path, readFileSync(absolute, 'utf8')]] : [];
      }),
    ),
  );
}

/** Same audit measured on the committed tree at `ref` (blobs, not the worktree). */
export function auditAtRef(repoRoot: string, ref: string) {
  const entries = listTreeFiles(repoRoot, ref, SEARCH_DIRS).filter(
    (entry) => /\.tsx?$/.test(entry.path) && !entry.path.endsWith('.d.ts'),
  );
  const sources = readBlobs(
    repoRoot,
    ref,
    entries.map((entry) => entry.path),
  );
  if (sources.size !== entries.length) {
    throw new Error(`cannot read every source blob at ${ref}`);
  }

  const schemaPaths = [
    'src/db/schema.ts',
    ...listTreeFiles(repoRoot, ref, ['src/db/schema'])
      .map((entry) => entry.path)
      .filter((path) => path.endsWith('.ts'))
      .sort(),
  ];
  const schemaBlobs = readBlobs(repoRoot, ref, schemaPaths);
  const schema = schemaPaths.map((path) => schemaBlobs.get(path) ?? '').join('\n');
  if (!schemaBlobs.get('src/db/schema.ts')) {
    throw new Error(`cannot read src/db/schema.ts at ${ref}`);
  }

  const initPaths = [MIGRATION_JOURNAL, SESSION_ORPHAN_MIGRATION, JUDGE_CONTROL_MIGRATION];
  const initBlobs = readBlobs(repoRoot, ref, initPaths);
  return auditSchemaWrites(
    schema,
    sources,
    new Map(
      initPaths.flatMap((path) => {
        const blob = initBlobs.get(path);
        return blob === undefined ? [] : [[path, blob] as const];
      }),
    ),
  );
}

/**
 * The drizzle schema is split across the src/db/schema.ts entry and the
 * domain modules under src/db/schema/; the audit needs every table
 * definition in one text, so read them concatenated.
 */
export function readSchemaAggregate(repoRoot = REPO_ROOT): string {
  const dir = resolve(repoRoot, 'src/db/schema');
  const parts = [readFileSync(resolve(repoRoot, 'src/db/schema.ts'), 'utf8')];
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    parts.push(readFileSync(join(dir, name), 'utf8'));
  }
  return parts.join('\n');
}

const stubKey = (r: WriteHit) => `${r.table}.${r.field}`;

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const listOnly = args.includes('--list');
  const baseIndex = args.indexOf('--base');
  if (baseIndex !== -1 && !args[baseIndex + 1]) throw new Error('--base requires a commit SHA.');
  const baseSha = resolveAuditBaseSha(
    REPO_ROOT,
    baseIndex === -1
      ? (process.env.CAPABILITY_BASE_SHA ?? process.env.TEST_POLICY_BASE)
      : args[baseIndex + 1],
  );

  const { results, retainedSchemas, judgeInitializationIssues } = audit();
  const retentionIssues = retainedSchemas.flatMap((retention) => retention.issues);
  const baseStubs = new Set(
    auditAtRef(REPO_ROOT, baseSha)
      .results.filter((r) => r.status === 'stub')
      .map(stubKey),
  );
  const stubs = results.filter((r) => r.status === 'stub');
  // The measured base is the only exemption: a field already stub at base stays
  // grandfathered; any head stub absent there is new debt and fails.
  const newStubs = stubs.filter((s) => !baseStubs.has(stubKey(s)));
  const grandfatheredStubs = stubs.filter((s) => baseStubs.has(stubKey(s)));

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          results,
          historicalRetention: retainedSchemas[0],
          retainedSchemas,
          newStubs,
          grandfatheredStubs,
          baseSha,
          judgeInitializationIssues,
        },
        null,
        2,
      ),
    );
    process.exit(
      listOnly
        ? 0
        : newStubs.length > 0 || retentionIssues.length > 0 || judgeInitializationIssues.length > 0
          ? 1
          : 0,
    );
  }

  console.log('\n=== Schema 字段健康表（仅显示非 live）===\n');
  console.log('| Table.Field | Type | INSERT files | UPDATE files | Status | Initialization |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.status === 'live') continue;
    const grandfathered = r.status === 'stub' && baseStubs.has(stubKey(r)) ? ' (base)' : '';
    console.log(
      `| ${r.table}.${r.field} | ${r.type} | ${r.insert_files} | ${r.update_files} | ${r.status}${grandfathered} | ${r.initialization?.migration ?? ''} |`,
    );
  }

  for (const retention of retainedSchemas) console.log(`\n${formatHistoricalRetention(retention)}`);
  console.log(`\nTotal fields audited: ${results.length}`);
  console.log(
    `  historical-retained: ${results.filter((field) => field.status === 'historical-retained').length}`,
  );
  console.log(`  live: ${results.filter((r) => r.status === 'live').length}`);
  console.log(`  init-only: ${results.filter((r) => r.status === 'init-only').length}`);
  console.log(`  update-only: ${results.filter((r) => r.status === 'update-only').length}`);
  console.log(
    `  stub (grandfathered at base ${baseSha.slice(0, 12)}): ${grandfatheredStubs.length}`,
  );
  console.log(`  stub (new vs base): ${newStubs.length}${newStubs.length > 0 ? ' ⚠️' : ''}`);

  if (judgeInitializationIssues.length > 0) {
    console.log('\nJudge initialization contract violations:');
    for (const issue of judgeInitializationIssues)
      console.log(`  - ${issue.message}${'path' in issue ? ` (${issue.path})` : ''}`);
    if (!listOnly) process.exit(1);
  }
  if (retentionIssues.length > 0 && !listOnly) process.exit(1);

  if (newStubs.length > 0 && !listOnly) {
    console.log('\n⚠️  New stub fields (no write path at head, not stub at base):\n');
    for (const s of newStubs) {
      console.log(`  - ${s.table}.${s.field} (${s.type})`);
    }
    console.log(
      '\n新字段必须自带 write path；无台账可登记。已存量的 stub 只按 base 实测放行，\n新增债无路可走——实现 write path 或删除该 schema 字段。',
    );
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
