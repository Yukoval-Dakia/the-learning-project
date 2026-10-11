/**
 * Schema write-path 防漂移 lint
 *
 * 起源：data-assumptions audit (2026-05-15) 发现 5+ stub 字段——schema 定义、零 write path。
 * 本脚本审计 `src/db/schema.ts` 所有业务字段，确保每个都有 INSERT 或 UPDATE write path；
 * 例外通过 `scripts/audit-schema-allowlist.json` 显式声明（含 reason + 解除条件）。
 *
 * 用法：
 *   pnpm audit:schema          # 报告 + 非零 exit 若有未声明 stub
 *   pnpm audit:schema --json   # JSON 输出
 *   pnpm audit:schema --list   # 只列字段健康表，不 enforce
 *
 * 实现：扫描 src/ + app/ 内所有 .ts/.tsx；另核对 0117/0118 注册 seed 的固定初始化契约。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
const ALLOWLIST_PATH = resolve(__dirname, 'audit-schema-allowlist.json');
const SEARCH_DIRS = ['src', 'app'];
const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git']);

type Field = { table: string; field: string; type: string };
type ResolveKind = 'pr' | 'phase' | 'manual';
type ResolvesWhen = {
  kind: ResolveKind;
  ref: string;
  expected_by: string;
};
type AllowlistEntry = { reason: string; resolves_when: ResolvesWhen };
type Allowlist = Record<string, AllowlistEntry>;
type AllowlistHygieneIssueCode =
  | 'invalid_entry'
  | 'missing_reason'
  | 'invalid_resolves_when'
  | 'invalid_kind'
  | 'invalid_ref'
  | 'invalid_expected_by'
  | 'expired_expected_by'
  | 'merged_pr'
  | 'shipped_phase';
export type AllowlistHygieneIssue = {
  key: string;
  code: AllowlistHygieneIssueCode;
  message: string;
};
type AllowlistHygieneOptions = {
  today: string;
  mergedPrRefs: Set<string>;
  statusText: string;
};
type AllowlistHygieneResult = {
  allowlist: Allowlist;
  issues: AllowlistHygieneIssue[];
};
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

// ADR-0058 / YUK-939 intentionally retired this writer, not its historical
// schema. This fixed inventory is a retention contract, never a dated allowance.
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

export function formatHistoricalRetention(retention: HistoricalRetention): string {
  return [
    `Historical retention: ${retention.table} (${retention.fields.length} columns)`,
    retention.reason,
    ...retention.fields.map((field) => `  ${field.table}.${field.field}: ${field.type}`),
    ...retention.issues.map((issue) => `  ${issue.code}: ${issue.message}`),
  ].join('\n');
}

const TRIVIAL_FIELDS = new Set(['id', 'created_at', 'updated_at', 'version', 'archived_at']);
const RESOLVE_KINDS = new Set<ResolveKind>(['pr', 'phase', 'manual']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function parseIsoDateStrict(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function addMonthsIso(value: string, months: number): string {
  const date = parseIsoDateStrict(value);
  if (!date) return value;
  date.setMonth(date.getMonth() + months);
  return todayIso(date);
}

function normalizePrRef(ref: string): string | null {
  const trimmed = ref.trim();
  const match =
    trimmed.match(/^#?(\d+)$/) ??
    trimmed.match(/^PR\s+#?(\d+)$/i) ??
    trimmed.match(/^pull\/(\d+)$/i) ??
    trimmed.match(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i);
  return match?.[1] ?? null;
}

function normalizePhaseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function isShippedStatusLine(line: string): boolean {
  return /^✅\s+(?:Phase\s+)?[\p{Letter}\p{Number}]/u.test(line);
}

function shippedPhaseStatusLines(statusText: string): string[] {
  const lines = statusText.split('\n');
  const out: string[] = [];
  let inPhaseSection = false;
  let inFence = false;

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inPhaseSection = /Phase\s*路线图|Phase\s+roadmap/i.test(line);
      inFence = false;
      continue;
    }
    if (!inPhaseSection) continue;
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence && isShippedStatusLine(line)) {
      out.push(line);
    }
  }

  return out;
}

function isPhaseShipped(ref: string, statusText: string): boolean {
  const normalizedRef = normalizePhaseText(ref);
  if (!normalizedRef) return false;
  return shippedPhaseStatusLines(statusText).some((line) => {
    const normalizedLine = normalizePhaseText(line);
    return ` ${normalizedLine} `.includes(` ${normalizedRef} `);
  });
}

export function extractMergedPrRefsFromGitLog(log: string): Set<string> {
  const refs = new Set<string>();
  for (const match of log.matchAll(/\(#(\d+)\)|Merge pull request #(\d+)/gi)) {
    const ref = match[1] ?? match[2];
    if (ref) refs.add(ref);
  }
  return refs;
}

function readMergedPrRefs(): Set<string> {
  try {
    const log = execFileSync(
      'git',
      ['log', '--oneline', '--first-parent', '--decorate=short', '-n', '2000'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return extractMergedPrRefsFromGitLog(log);
  } catch {
    return new Set();
  }
}

function readStatusText(): string {
  const statusPath = resolve(REPO_ROOT, 'docs/superpowers/status.md');
  if (!existsSync(statusPath)) return '';
  return readFileSync(statusPath, 'utf8');
}

function issue(
  key: string,
  code: AllowlistHygieneIssueCode,
  message: string,
): AllowlistHygieneIssue {
  return { key, code, message };
}

export function validateAllowlistHygiene(
  raw: unknown,
  options: AllowlistHygieneOptions,
): AllowlistHygieneResult {
  const allowlist: Allowlist = {};
  const issues: AllowlistHygieneIssue[] = [];

  if (!isRecord(raw)) {
    return {
      allowlist,
      issues: [issue('<root>', 'invalid_entry', 'allowlist root must be a JSON object')],
    };
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;

    if (!isRecord(value)) {
      issues.push(issue(key, 'invalid_entry', 'allowlist entry must be an object'));
      continue;
    }

    const reason = value.reason;
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      issues.push(issue(key, 'missing_reason', 'allowlist entry requires non-empty reason'));
      continue;
    }

    const resolvesWhen = value.resolves_when;
    if (!isRecord(resolvesWhen)) {
      issues.push(
        issue(
          key,
          'invalid_resolves_when',
          'resolves_when must be { kind, ref, expected_by }, not a legacy string',
        ),
      );
      continue;
    }

    const kind = resolvesWhen.kind;
    const ref = resolvesWhen.ref;
    const expectedBy = resolvesWhen.expected_by;

    if (typeof kind !== 'string' || !RESOLVE_KINDS.has(kind as ResolveKind)) {
      issues.push(
        issue(key, 'invalid_kind', "resolves_when.kind must be 'pr', 'phase', or 'manual'"),
      );
      continue;
    }
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      issues.push(issue(key, 'invalid_ref', 'resolves_when.ref must be a non-empty string'));
      continue;
    }
    if (typeof expectedBy !== 'string' || !ISO_DATE_RE.test(expectedBy)) {
      issues.push(
        issue(key, 'invalid_expected_by', 'resolves_when.expected_by must be YYYY-MM-DD'),
      );
      continue;
    }
    if (!parseIsoDateStrict(expectedBy)) {
      issues.push(
        issue(key, 'invalid_expected_by', 'resolves_when.expected_by must be a valid date'),
      );
      continue;
    }
    if (expectedBy < options.today) {
      issues.push(
        issue(
          key,
          'expired_expected_by',
          `resolves_when.expected_by ${expectedBy} is before ${options.today}`,
        ),
      );
      continue;
    }
    const maxExpectedBy = addMonthsIso(options.today, 12);
    if (expectedBy > maxExpectedBy) {
      issues.push(
        issue(
          key,
          'invalid_expected_by',
          `resolves_when.expected_by ${expectedBy} is more than 12 months after ${options.today}`,
        ),
      );
      continue;
    }

    if (kind === 'pr') {
      const prRef = normalizePrRef(ref);
      if (!prRef) {
        issues.push(issue(key, 'invalid_ref', 'pr resolves_when.ref must contain a PR number'));
        continue;
      }
      if (options.mergedPrRefs.has(prRef)) {
        issues.push(issue(key, 'merged_pr', `resolves_when PR #${prRef} is already merged`));
        continue;
      }
    }

    if (kind === 'phase' && isPhaseShipped(ref, options.statusText)) {
      issues.push(issue(key, 'shipped_phase', `resolves_when phase "${ref}" is already shipped`));
      continue;
    }

    allowlist[key] = {
      reason,
      resolves_when: {
        kind: kind as ResolveKind,
        ref,
        expected_by: expectedBy,
      },
    };
  }

  return { allowlist, issues };
}

// Drizzle column constructors recognised by parseSchema. The first group are
// native drizzle-orm/pg-core builders; `vector` is the project customType
// (src/db/vector.ts, YUK-383) — without it the `embedding: vector(1024)` columns
// escape parsing entirely and stay invisible to write-path drift detection
// (YUK-385). Append future project customType constructor names here so their
// columns are audited automatically.
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
      // 跳过 schema constraint helpers
      if (SCHEMA_CONSTRAINT_HELPERS.has(m[2])) continue;
      fields.push({ table: tableName, field: m[1], type: m[2] });
    }
  }
  return fields;
}

function loadAllowlist(): unknown {
  if (!existsSync(ALLOWLIST_PATH)) return {};
  return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
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

// A single drizzle write statement, scoped to the table it targets. `kind`
// distinguishes INSERT from UPDATE; `payload` is either a direct object literal
// or the top-level keys proved by bounded AST construction/caller tracing.
// Field matching reads top-level syntax keys only, confined to THIS statement
// (YUK-166: the old file-level matcher ignored table identity and let a write to
// `mistake_variant.parent_question_id` satisfy `question.parent_question_id`).
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

export function buildProductionWriteIndex(
  sources: ReadonlyMap<string, string>,
): Map<string, WriteStatement[]> {
  const production = new Map([...sources].filter(([path]) => isProductionSource(path)));
  const index = extractDrizzleWriteIndex(
    production,
    new Set(['subagent_run', 'judge_run_control']),
  );
  for (const [path, source] of production) {
    index.set(path, [...(index.get(path) ?? []), ...extractExecutedSqlWrites(source)]);
  }
  return index;
}

function statementMatchesField(payload: string, field: string): boolean {
  return payloadColumns(payload).has(field);
}

// Table-aware write-path count (YUK-166). A field counts as written only when a
// statement targeting ITS OWN table carries it; a same-named column on another
// table no longer cross-satisfies. Counts are per-file (a file with any matching
// insert/update statement for the table contributes one).
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
    readFileSync(resolve(repoRoot, 'src/db/schema.ts'), 'utf8'),
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

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const listOnly = args.includes('--list');

  const { results, retainedSchemas, judgeInitializationIssues } = audit();
  const retentionIssues = retainedSchemas.flatMap((retention) => retention.issues);
  const hygiene = validateAllowlistHygiene(loadAllowlist(), {
    today: todayIso(),
    mergedPrRefs: readMergedPrRefs(),
    statusText: readStatusText(),
  });
  const allowlist = hygiene.allowlist;
  const stubs = results.filter((r) => r.status === 'stub');
  const unallowedStubs = stubs.filter((s) => !allowlist[`${s.table}.${s.field}`]);
  const allowedStubs = stubs.filter((s) => allowlist[`${s.table}.${s.field}`]);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          results,
          historicalRetention: retainedSchemas[0],
          retainedSchemas,
          unallowedStubs,
          allowedStubs,
          allowlistIssues: hygiene.issues,
          judgeInitializationIssues,
        },
        null,
        2,
      ),
    );
    process.exit(
      listOnly
        ? 0
        : unallowedStubs.length > 0 ||
            hygiene.issues.length > 0 ||
            retentionIssues.length > 0 ||
            judgeInitializationIssues.length > 0
          ? 1
          : 0,
    );
  }

  console.log('\n=== Schema 字段健康表（仅显示非 live）===\n');
  console.log('| Table.Field | Type | INSERT files | UPDATE files | Status | Initialization |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.status === 'live') continue;
    const allowed = allowlist[`${r.table}.${r.field}`] ? ' (allowed)' : '';
    console.log(
      `| ${r.table}.${r.field} | ${r.type} | ${r.insert_files} | ${r.update_files} | ${r.status}${allowed} | ${r.initialization?.migration ?? ''} |`,
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
  console.log(`  stub (allowed): ${allowedStubs.length}`);
  console.log(
    `  stub (unallowed): ${unallowedStubs.length}${unallowedStubs.length > 0 ? ' ⚠️' : ''}`,
  );

  if (judgeInitializationIssues.length > 0) {
    console.log('\nJudge initialization contract violations:');
    for (const issue of judgeInitializationIssues)
      console.log(`  - ${issue.message}${'path' in issue ? ` (${issue.path})` : ''}`);
    if (!listOnly) process.exit(1);
  }
  if (retentionIssues.length > 0 && !listOnly) process.exit(1);

  if (hygiene.issues.length > 0 && !listOnly) {
    console.log('\n⚠️  Allowlist hygiene issues found:\n');
    for (const item of hygiene.issues) {
      console.log(`  - ${item.key}: ${item.code} — ${item.message}`);
    }
    console.log(
      "\nUse resolves_when: { kind: 'pr' | 'phase' | 'manual', ref: string, expected_by: 'YYYY-MM-DD' }.",
    );
    process.exit(1);
  }

  if (unallowedStubs.length > 0 && !listOnly) {
    console.log('\n⚠️  Unallowed stubs found:\n');
    for (const s of unallowedStubs) {
      console.log(`  - ${s.table}.${s.field} (${s.type})`);
    }
    console.log(
      '\n如该字段确实计划留 stub，加入 scripts/audit-schema-allowlist.json 并附 reason + resolves_when。\n如不要保留，删 schema 定义。',
    );
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
