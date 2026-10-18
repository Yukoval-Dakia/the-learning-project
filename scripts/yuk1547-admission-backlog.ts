/* SIZE_OK: one auditable ops driver — eligibility + publish + settle + guardrail
 * + invariant checks share one sequential state machine; splitting would scatter
 * the per-question receipt contract it exists to produce. */
/**
 * YUK-1547 — formal backlog driver for the remaining admission sends.
 *
 * Scope: the owner-approved continuation of the 112-question backlog after the
 * 2026-10-19 window settled 3 items (2 unknown@HTTP400, 1 applied). This script
 * runs the remaining manifest items ONE AT A TIME through the regular
 * publisher → event-outbox → durable-subscriber → pg-boss path, receipts every
 * question, and stops on the configured guardrails.
 *
 * Hard rules (coordination line, verbatim):
 *   - STOP is a FILE (out-dir/STOP.json), not a PID. It is checked before every
 *     enqueue and after every settle; once written it is never deleted by this
 *     script — resume happens by operator decision, not auto-retry.
 *   - A question is never sent before the previous question's HTTP status has
 *     been parsed and its receipt written.
 *   - HTTP status comes from the structured `provider_http_error={...}` marker
 *     inside error_message / unresolved_reason — extracted as JSON (balanced
 *     object span → JSON.parse), never regexed out of serialized text.
 *   - Unparseable evidence fails closed: ambiguous parse → stop.
 *   - cost_usd=null is UNKNOWN cost (never normalized to zero); unknown runs
 *     count against the hard cap at the configured reserve.
 *   - Already-sent items are explicit: --sent lists ids that must NOT appear in
 *     the manifest (overlap is a hard error — unknown/paid rows never replay).
 *   - Old paid_effect rows and preexisting withheld lifecycle rows are
 *     snapshotted into baseline.json at window start and re-verified every
 *     batch; new unknown rows may only resolve via the reconciler, and a
 *     baseline 'applied' row changing is an invariant violation.
 *   - Thresholds are explicit CLI config (defaults = approved values) and are
 *     recorded in baseline + every receipt.
 *
 * usage:
 *   tsx scripts/yuk1547-admission-backlog.ts check --manifest <m.json> <group_id>
 *   tsx scripts/yuk1547-admission-backlog.ts drive --manifest <m.json> --out <dir>
 *       --preflight-receipt <path> [--batch N] [--batch-size 20]
 *       [--per-question-usd 0.03] [--cumulative-usd 1] [--hard-cap-usd 3]
 *       [--unknown-reserve-usd 0.01] [--max-unknown-rate 0.1]
 *       [--poll-ms 5000] [--settle-timeout-ms 900000] [--sent <ids.json>]
 *
 * Env: DATABASE_URL (reads + writes the deployment DB; the live worker picks
 * up the publisher outbox event). No docker exec, no keychain reads, no
 * provider calls from this script.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Provider } from '@/ai/task-spec';
import {
  ADMISSION_FAMILY,
  lockAdmissionGroup,
} from '@/capabilities/practice/server/admission/enqueue';
import { resolveQuestionAdmissionPolicyId } from '@/capabilities/practice/server/admission/run-admission';
import { QUESTION_ADMISSION_TASK_KIND } from '@/capabilities/practice/server/admission/solve';
import {
  QUESTION_ADMISSION_PAID_UNIT,
  QUESTION_ADMISSION_POLICY_ID,
} from '@/core/question-admission-policy';
import type { Db, Tx } from '@/db/client';
import { lockPaidEffectControlFamily, readPaidEffectControl } from '@/db/paid-effect-control';
import { type TaskNativeReasoningParams, resolveTaskBinding } from '@/server/ai/providers';

const TASK_KIND = QUESTION_ADMISSION_TASK_KIND;
const FAMILY = ADMISSION_FAMILY;
const PAID_UNIT = QUESTION_ADMISSION_PAID_UNIT;
const ACTOR_REF = 'stage1:backlog_readmission_b_112_20261019';

// Approved guardrail values for this recovery window (coordination line:
// per-question >$0.03 stops — the retired $0.01 bound belongs to the sealed
// window and is never applied to it; cumulative >$1 stops; the $3 hard cap is
// known cost + unknown calls valued at the reserve).
const DEFAULTS = {
  batchSize: 20,
  perQuestionUsd: 0.03,
  cumulativeUsd: 1.0,
  hardCapUsd: 3.0,
  unknownReserveUsd: 0.01,
  maxUnknownRate: 0.1,
  pollMs: 5000,
  settleTimeoutMs: 15 * 60 * 1000,
} as const;

const manifestItem = z.object({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  suspended: z.boolean(),
  created_at: z.string(),
  generation: z.number().int().nonnegative(),
  revision_id: z.string().min(1),
  integrity_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  question_updated_at: z.string().optional(),
  lifecycle_updated_at: z.string().optional(),
});
type ManifestItem = z.infer<typeof manifestItem>;
const manifestSchema = z.array(manifestItem).nonempty();

interface Thresholds {
  batchSize: number;
  perQuestionUsd: number;
  cumulativeUsd: number;
  hardCapUsd: number;
  unknownReserveUsd: number;
  maxUnknownRate: number;
  pollMs: number;
  settleTimeoutMs: number;
}

interface ExpectedRoute {
  provider: Provider;
  model: string;
  reasoning?: TaskNativeReasoningParams;
  selectionRule: string;
}

const sha256 = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
const stableJson = (value: unknown) => JSON.stringify(canonicalize(value));

async function readJson<T>(path: string, schema?: z.ZodType<T>): Promise<T> {
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return schema ? schema.parse(parsed) : (parsed as T);
}

/** PG 'YYYY-MM-DD HH:MM:SS.ffffff' (naive, deployment TZ) → epoch ms. */
function manifestTimestampMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? undefined : ms;
}

// ─── provider_http_error structured parse ────────────────────────────────────

type HttpEvidence =
  | { kind: 'absent' }
  | { kind: 'parsed'; http_status: number; request_id?: string; body?: string }
  | { kind: 'ambiguous'; detail: string };

const HTTP_ERROR_MARKER = 'provider_http_error=';

/**
 * Extract the JSON object after `provider_http_error=` and JSON.parse it.
 * The object is located by balanced-brace scanning with string/escape
 * awareness — never a regex over serialized status text. Absent marker →
 * 'absent'; malformed span or non-object → 'ambiguous' (fail-closed).
 */
export function parseProviderHttpError(text: string | null | undefined): HttpEvidence {
  if (!text) return { kind: 'absent' };
  const markerAt = text.indexOf(HTTP_ERROR_MARKER);
  if (markerAt < 0) return { kind: 'absent' };
  let i = markerAt + HTTP_ERROR_MARKER.length;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  if (text[i] !== '{') {
    return { kind: 'ambiguous', detail: `marker at ${markerAt} not followed by a JSON object` };
  }
  const start = i;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) {
    return { kind: 'ambiguous', detail: `unterminated JSON object after marker at ${markerAt}` };
  }
  const parsed: unknown = JSON.parse(text.slice(start, end));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'ambiguous', detail: 'provider_http_error payload is not a JSON object' };
  }
  const evidence = parsed as { http_status?: unknown; request_id?: unknown; body?: unknown };
  if (typeof evidence.http_status !== 'number' || !Number.isInteger(evidence.http_status)) {
    return { kind: 'ambiguous', detail: 'provider_http_error has no integer http_status' };
  }
  return {
    kind: 'parsed',
    http_status: evidence.http_status,
    ...(typeof evidence.request_id === 'string' ? { request_id: evidence.request_id } : {}),
    ...(typeof evidence.body === 'string' ? { body: evidence.body } : {}),
  };
}

// ─── db boot ─────────────────────────────────────────────────────────────────

let dbHandle: Db | undefined;
let configEpoch = 0;
async function dbBoot(): Promise<Db> {
  const { db } = await import('@/db/client');
  const { hydrateConfigFromDb } = await import('@/server/config/hydrate');
  const hydration = await hydrateConfigFromDb(db);
  // Paid preflight semantics: a failed/stale hydrate must not read as success.
  if (hydration.outcome === 'failed' || hydration.outcome === 'stale') {
    throw new Error(`config hydration outcome=${hydration.outcome} — refusing paid ops`);
  }
  configEpoch = hydration.epoch;
  dbHandle = db;
  return db;
}

// ─── expected route resolution (mirrors the job) ────────────────────────────

function expectedRoutes(): { solverA: ExpectedRoute; solverB: ExpectedRoute } {
  const solverA = resolveTaskBinding(TASK_KIND);
  const solver2Provider = process.env.QUESTION_ADMISSION_SOLVER2_PROVIDER;
  const solver2Model = process.env.QUESTION_ADMISSION_SOLVER2_MODEL;
  const override =
    solver2Provider || solver2Model
      ? {
          ...(solver2Provider ? { provider: solver2Provider as Provider } : {}),
          ...(solver2Model ? { model: solver2Model } : {}),
        }
      : undefined;
  const solverB = resolveTaskBinding(TASK_KIND, override);
  return { solverA: solverA as ExpectedRoute, solverB: solverB as ExpectedRoute };
}

const routePair = (route: ExpectedRoute) => `${route.provider}/${route.model}`;

// ─── publish (regular publisher seam, same gates as the sealed window) ──────

async function eligibilityFailure(tx: Tx, item: ManifestItem): Promise<string[]> {
  const failures: string[] = [];
  const { question_revision, paid_effect } = await import('@/db/schema');
  const { root, lifecycle } = await lockAdmissionGroup(tx, item.id);
  if (!root) {
    return ['group root missing'];
  }
  if (root.parent_question_id !== null) failures.push('not a group root');
  if (root.source !== 'web_sourced') failures.push('not web_sourced');
  if (!lifecycle) failures.push('lifecycle missing');
  if (lifecycle) {
    if (lifecycle.withdrawn) failures.push('withdrawn');
    if (lifecycle.suspended) failures.push('suspended');
    if (lifecycle.scoring_admission_state !== 'admitted') failures.push('not admitted');
    if (lifecycle.scoring_admission_evidence?.marking_provenance !== 'official') {
      failures.push('marking_provenance not official');
    }
    if (lifecycle.scoring_admission_generation !== item.generation) {
      failures.push(
        `admission generation changed: expected ${item.generation}, saw ${lifecycle.scoring_admission_generation}`,
      );
    }
    if (lifecycle.current_revision_id !== item.revision_id) {
      failures.push(`current revision changed: expected ${item.revision_id}`);
    }
  }
  if (root.version !== item.version) {
    failures.push(`question version changed: expected ${item.version}, saw ${root.version}`);
  }
  const expectedUpdatedMs = manifestTimestampMs(item.question_updated_at);
  if (expectedUpdatedMs !== undefined && root.updated_at.getTime() !== expectedUpdatedMs) {
    failures.push('question updated_at changed');
  }
  const [revision] = await tx
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, item.revision_id));
  if (!revision || revision.integrity_digest !== item.integrity_digest) {
    failures.push('revision digest mismatch');
  }
  const paid = await tx
    .select()
    .from(paid_effect)
    .where(and(eq(paid_effect.family, FAMILY), eq(paid_effect.entity_id, item.id)));
  if (paid.length > 0) failures.push(`prior admission paid record: ${paid.length} row(s)`);
  const jobs = (await tx.execute(
    sql`select id from pgboss.job where name=${FAMILY} and data->>'question_id'=${item.id} and state in ('created','retry','active')`,
  )) as unknown as { id: string }[];
  if (jobs.length > 0) failures.push(`existing pending admission job(s): ${jobs.length}`);
  return failures;
}

interface PublishReceipt {
  group_id: string;
  admission: 'skipped' | 'updated';
  revision_id: string | null;
  generation: number;
  event_emitted: boolean;
}

async function publishOne(tx: Tx, item: ManifestItem): Promise<PublishReceipt> {
  await lockPaidEffectControlFamily(tx, FAMILY);
  const control = await readPaidEffectControl(tx, FAMILY);
  if (control.backend !== 'pg-boss') {
    throw new Error('paid-effect control backend is not pg-boss — producer is fenced');
  }
  const failures = await eligibilityFailure(tx, item);
  if (failures.length > 0) {
    throw new Error(`eligibility: ${failures.join('; ')}`);
  }
  const { publishQuestionGroupFromRow } = await import('@/kernel/records/assessment-publication');
  const result = await publishQuestionGroupFromRow(tx, {
    rootId: item.id,
    admission: { state: 'withheld', reason: 'unverified_rules' },
    actorRef: ACTOR_REF,
    now: new Date(),
  });
  if (result.status !== 'admission_updated' && result.status !== 'noop') {
    throw new Error(`unexpected publish result status: ${result.status}`);
  }
  const { root, lifecycle } = await lockAdmissionGroup(tx, item.id);
  if (!root || !lifecycle) throw new Error('group root or lifecycle missing after publish');
  if (
    lifecycle.scoring_admission_state !== 'withheld' ||
    lifecycle.scoring_admission_withheld_reason !== 'unverified_rules'
  ) {
    throw new Error('publish did not mark the group pending admission (withheld/unverified_rules)');
  }
  if (lifecycle.current_revision_id !== item.revision_id) {
    throw new Error('publish minted a new revision — manifest revision binding violated');
  }
  if (lifecycle.scoring_admission_generation !== item.generation + 1) {
    throw new Error(
      `publish did not advance admission generation to ${item.generation + 1} (saw ${lifecycle.scoring_admission_generation})`,
    );
  }
  return {
    group_id: item.id,
    admission: result.status === 'admission_updated' ? 'updated' : 'skipped',
    revision_id: lifecycle.current_revision_id,
    generation: lifecycle.scoring_admission_generation,
    event_emitted: result.status === 'admission_updated',
  };
}

// ─── settle polling ─────────────────────────────────────────────────────────

type AiTaskRunRow = typeof import('@/db/schema').ai_task_runs['$inferSelect'];
type PaidRow = typeof import('@/db/schema').paid_effect['$inferSelect'];

interface JobRow {
  id: string;
  state: string;
  retry_count: number;
  created_on: string;
  completed_on: string | null;
}

async function snapshot(db: Db, groupId: string, sentAtIso: string) {
  const { paid_effect, ai_task_runs } = await import('@/db/schema');
  const paid: PaidRow[] = await db
    .select()
    .from(paid_effect)
    .where(and(eq(paid_effect.family, FAMILY), eq(paid_effect.entity_id, groupId)));
  const jobs = (await db.execute(
    sql`select id,state,retry_count,created_on,completed_on from pgboss.job where name=${FAMILY} and data->>'question_id'=${groupId} order by created_on`,
  )) as unknown as JobRow[];
  const runs: AiTaskRunRow[] = await db
    .select()
    .from(ai_task_runs)
    .where(
      and(eq(ai_task_runs.task_kind, TASK_KIND), gte(ai_task_runs.started_at, new Date(sentAtIso))),
    );
  return { paid, jobs, runs };
}

const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_PAID_STATES = new Set(['applied', 'unknown']);

// ─── baselines / invariants ─────────────────────────────────────────────────

interface Baseline {
  created_at: string;
  manifest_sha256: string;
  manifest_count: number;
  sent_ids: string[];
  thresholds: Thresholds;
  expected_routes: { solverA: ExpectedRoute; solverB: ExpectedRoute };
  policy_id: string;
  config_epoch: number;
  preflight: { path: string; sha256: string; passed: boolean; probes: unknown };
  paid_baseline: { key: string; state: string; serialized: string }[];
  withheld_baseline: { group_id: string; serialized: string }[];
}

async function paidBaselineSnapshot(db: Db) {
  const { paid_effect } = await import('@/db/schema');
  const rows = await db.select().from(paid_effect).where(eq(paid_effect.family, FAMILY));
  return rows.map((row) => ({
    key: [row.entity_id, row.entity_revision, row.unit, row.input_digest].join('|'),
    state: row.state,
    serialized: stableJson({
      family: row.family,
      entity_id: row.entity_id,
      entity_revision: row.entity_revision,
      unit: row.unit,
      input_digest: row.input_digest,
      state: row.state,
    }),
  }));
}

async function withheldBaselineSnapshot(db: Db) {
  const { question_group_lifecycle } = await import('@/db/schema');
  const rows = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.scoring_admission_state, 'withheld'));
  return rows.map((row) => ({
    group_id: row.group_id,
    serialized: stableJson(row),
  }));
}

async function checkInvariants(
  db: Db,
  baseline: Baseline,
  manifestIds: Set<string>,
): Promise<string[]> {
  const violations: string[] = [];
  const { paid_effect, question_group_lifecycle } = await import('@/db/schema');
  const paidRows = await db.select().from(paid_effect).where(eq(paid_effect.family, FAMILY));
  const paidByKey = new Map(
    paidRows.map((row) => [
      [row.entity_id, row.entity_revision, row.unit, row.input_digest].join('|'),
      row,
    ]),
  );
  for (const old of baseline.paid_baseline) {
    const row = paidByKey.get(old.key);
    if (!row) {
      violations.push(`baseline paid row disappeared: ${old.key}`);
      continue;
    }
    // An old 'applied' row is immutable truth — reconciling an old 'unknown'
    // row to applied is legitimate reconciler work, never this driver's send.
    if (old.state === 'applied' && row.state !== 'applied') {
      violations.push(`baseline applied paid row changed state: ${old.key} → ${row.state}`);
    }
  }
  const withheldRows = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.scoring_admission_state, 'withheld'));
  const withheldById = new Map(withheldRows.map((row) => [row.group_id, row]));
  for (const old of baseline.withheld_baseline) {
    if (manifestIds.has(old.group_id)) continue; // manifest items legitimately flip state
    const row = withheldById.get(old.group_id);
    if (!row || stableJson(row) !== old.serialized) {
      violations.push(`preexisting withheld lifecycle row changed: ${old.group_id}`);
    }
  }
  return violations;
}

// ─── receipt io ─────────────────────────────────────────────────────────────

const intentPath = (outDir: string, id: string) => join(outDir, `intent-${id}.json`);
const receiptPath = (outDir: string, id: string) => join(outDir, `question-${id}.json`);
const livePath = (outDir: string, id: string) => join(outDir, `live-${id}.json`);
const stopPath = (outDir: string) => join(outDir, 'STOP.json');
const batchPath = (outDir: string, n: number) => join(outDir, `batch-${n}-receipt.json`);
const baselinePath = (outDir: string) => join(outDir, 'baseline.json');

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function writeStop(
  outDir: string,
  reason: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const path = stopPath(outDir);
  if (await fileExists(path)) return; // first stop wins; never overwrite
  await writeFile(
    path,
    JSON.stringify({ stopped_at: new Date().toISOString(), reason, ...detail }, null, 2),
  );
}

// ─── preflight receipt verification ─────────────────────────────────────────

interface PreflightReceipt {
  passed: boolean;
  probes: {
    solver: 'A' | 'B';
    mode: 'solve' | 'source_crosscheck';
    provider: string;
    model: string;
    http_status?: number;
    provider_error?: unknown;
  }[];
}

function verifyPreflightReceipt(
  receipt: PreflightReceipt,
  routes: { solverA: ExpectedRoute; solverB: ExpectedRoute },
): string[] {
  const problems: string[] = [];
  if (receipt.passed !== true) problems.push('preflight receipt is not passed=true');
  const probes = receipt.probes ?? [];
  for (const [solver, route] of [
    ['A', routes.solverA],
    ['B', routes.solverB],
  ] as const) {
    const probe = probes.find(
      (p) =>
        p.solver === solver &&
        p.mode === 'solve' &&
        p.provider === route.provider &&
        p.model === route.model,
    );
    if (!probe) problems.push(`no passing solve probe for solver ${solver} (${routePair(route)})`);
    else if (probe.http_status !== 200) {
      problems.push(`solve probe for solver ${solver} was http ${probe.http_status}`);
    }
  }
  const xc = probes.find(
    (p) =>
      p.mode === 'source_crosscheck' &&
      p.provider === routes.solverA.provider &&
      p.model === routes.solverA.model,
  );
  if (!xc) problems.push('no passing source_crosscheck probe on the primary route');
  else if (xc.http_status !== 200) problems.push(`crosscheck probe was http ${xc.http_status}`);
  return problems;
}

// ─── drive ──────────────────────────────────────────────────────────────────

interface ItemReceipt {
  group_id: string;
  batch: number;
  index: number;
  started_at: string;
  finished_at: string;
  publish?: PublishReceipt;
  paid_state: string;
  unresolved_reason: string | null;
  outcome: string | null;
  reason: string | null;
  cost_known_usd: number;
  unknown_cost_run_ids: string[];
  runs: (AiTaskRunRow & { http_status?: number; http_error?: HttpEvidence })[];
  jobs: JobRow[];
  alarms: string[];
  settle_timeout: boolean;
  thresholds: Thresholds;
  pre_c6_note: string;
}

const PRE_C6_NOTE =
  'Individual raw HTTP request payloads are not archived (pre-C6 evidence gap); ' +
  'route/native-params truth is the resolved binding + task_run provider/model columns.';

async function loadCumulative(outDir: string): Promise<{
  knownUsd: number;
  unknownCalls: number;
  unknownQuestions: number;
  processed: number;
}> {
  const files = (await readdir(outDir)).filter((name) => /^question-[^/]+\.json$/.test(name));
  let knownUsd = 0;
  let unknownCalls = 0;
  let unknownQuestions = 0;
  for (const name of files) {
    const receipt = await readJson<ItemReceipt>(join(outDir, name));
    knownUsd += receipt.cost_known_usd;
    unknownCalls += receipt.unknown_cost_run_ids.length;
    if (receipt.paid_state === 'unknown') unknownQuestions += 1;
  }
  return { knownUsd, unknownCalls, unknownQuestions, processed: files.length };
}

function evaluateQuestion(
  receipt: Pick<ItemReceipt, 'runs' | 'cost_known_usd'>,
  cumulativeKnownUsd: number,
  cumulativeUnknownCalls: number,
  thresholds: Thresholds,
  expectedPairs: Set<string>,
): string[] {
  const alarms: string[] = [];
  for (const run of receipt.runs) {
    if (!expectedPairs.has(`${run.provider}/${run.model}`)) {
      alarms.push(`wrong_route:${run.provider}/${run.model}`);
    }
  }
  if (receipt.cost_known_usd > thresholds.perQuestionUsd) {
    alarms.push(
      `per_question_cost:$${receipt.cost_known_usd.toFixed(6)}>$${thresholds.perQuestionUsd}`,
    );
  }
  if (cumulativeKnownUsd > thresholds.cumulativeUsd) {
    alarms.push(`cumulative_cost:$${cumulativeKnownUsd.toFixed(6)}>$${thresholds.cumulativeUsd}`);
  }
  const boundedTotal = cumulativeKnownUsd + cumulativeUnknownCalls * thresholds.unknownReserveUsd;
  if (boundedTotal > thresholds.hardCapUsd) {
    alarms.push(`hard_cap:$${boundedTotal.toFixed(6)}>$${thresholds.hardCapUsd}`);
  }
  return alarms;
}

async function drive(opts: {
  manifestPath: string;
  outDir: string;
  batch?: number;
  thresholds: Thresholds;
  preflightReceipt?: string;
  sentIdsPath?: string;
}): Promise<void> {
  const db = await dbBoot();
  const manifest = await readJson(opts.manifestPath, manifestSchema);
  const manifestIds = new Set(manifest.map((item) => item.id));
  if (manifestIds.size !== manifest.length) throw new Error('manifest contains duplicate ids');
  const manifestDigest = sha256(manifest);
  const sentIds = opts.sentIdsPath ? await readJson<string[]>(opts.sentIdsPath) : [];
  const leaked = sentIds.filter((id) => manifestIds.has(id));
  if (leaked.length > 0) {
    throw new Error(`already-sent ids present in manifest — never replay: ${leaked.join(', ')}`);
  }
  const policy = resolveQuestionAdmissionPolicyId();
  if (policy !== QUESTION_ADMISSION_POLICY_ID) {
    throw new Error(
      `resolved admission policy '${policy}' is not '${QUESTION_ADMISSION_POLICY_ID}'`,
    );
  }
  const routes = expectedRoutes();
  const expectedPairs = new Set([routePair(routes.solverA), routePair(routes.solverB)]);
  await mkdir(opts.outDir, { recursive: true });

  // STOP is a file and is permanent once written — resume is the operator's
  // deliberate decision in a fresh window/dir, never this script's.
  if (await fileExists(stopPath(opts.outDir))) {
    const stop = await readFile(stopPath(opts.outDir), 'utf8');
    throw new Error(`STOP file present — refusing to enqueue:\n${stop}`);
  }

  // ── baseline: create once at window start, reuse afterwards ──
  const baselineFile = baselinePath(opts.outDir);
  let baseline: Baseline;
  if (!(await fileExists(baselineFile))) {
    if (!opts.preflightReceipt) {
      throw new Error('--preflight-receipt is required to open a new window (first drive run)');
    }
    const receipt = await readJson<PreflightReceipt>(opts.preflightReceipt);
    const problems = verifyPreflightReceipt(receipt, routes);
    if (problems.length > 0) {
      throw new Error(`preflight receipt fails coverage: ${problems.join('; ')}`);
    }
    baseline = {
      created_at: new Date().toISOString(),
      manifest_sha256: manifestDigest,
      manifest_count: manifest.length,
      sent_ids: sentIds,
      thresholds: opts.thresholds,
      expected_routes: routes,
      policy_id: policy,
      config_epoch: configEpoch,
      preflight: {
        path: opts.preflightReceipt,
        sha256: sha256(receipt),
        passed: receipt.passed,
        probes: receipt.probes?.map((p) => ({
          solver: p.solver,
          mode: p.mode,
          provider: p.provider,
          model: p.model,
          http_status: p.http_status,
        })),
      },
      paid_baseline: await paidBaselineSnapshot(db),
      withheld_baseline: await withheldBaselineSnapshot(db),
    };
    await writeFile(baselineFile, JSON.stringify(baseline, null, 2));
    console.log(`baseline written: ${baselineFile}`);
  } else {
    baseline = await readJson<Baseline>(baselineFile);
    if (baseline.manifest_sha256 !== manifestDigest) {
      throw new Error('manifest changed since baseline — refusing to mix windows');
    }
    if (stableJson(baseline.thresholds) !== stableJson(opts.thresholds)) {
      throw new Error('threshold flags differ from the recorded baseline thresholds');
    }
  }

  const batchSize = opts.thresholds.batchSize;
  const batches = Math.ceil(manifest.length / batchSize);
  const batchNumbers =
    opts.batch !== undefined ? [opts.batch] : [...Array(batches).keys()].map((i) => i + 1);

  for (const batchN of batchNumbers) {
    const items = manifest.slice((batchN - 1) * batchSize, batchN * batchSize);
    if (items.length === 0) throw new Error(`batch ${batchN} is empty`);
    const batchFile = batchPath(opts.outDir, batchN);
    if (await fileExists(batchFile)) {
      console.log(`batch ${batchN} already receipted — skipping`);
      continue;
    }
    if (batchN > 1 && !(await fileExists(batchPath(opts.outDir, batchN - 1)))) {
      throw new Error(`batch ${batchN - 1} receipt missing — batches run in order`);
    }

    // Batch-open invariant check against the window baseline.
    const openViolations = await checkInvariants(db, baseline, manifestIds);
    if (openViolations.length > 0) {
      await writeStop(opts.outDir, 'invariant_violation', {
        batch: batchN,
        violations: openViolations,
      });
      throw new Error(`batch ${batchN} open invariants: ${openViolations.join('; ')}`);
    }

    const stats = { items: [] as string[], unknown: 0, knownUsd: 0, unknownCalls: 0 };
    let stopped: string | undefined;

    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx];
      if (await fileExists(stopPath(opts.outDir))) {
        stopped = 'stop_file_present';
        break;
      }
      const receiptFile = receiptPath(opts.outDir, item.id);
      if (await fileExists(receiptFile)) {
        stats.items.push(`${item.id}:already-settled`);
        continue; // never replay — resume skips the settled item
      }
      const intentFile = intentPath(opts.outDir, item.id);
      const hasIntent = await fileExists(intentFile);
      let sentAt: string;
      let publishReceipt: PublishReceipt | undefined;
      if (hasIntent) {
        // Published but not receipted (crash between publish and settle):
        // settle the existing send — never republish.
        const intent = await readJson<{ sent_at: string }>(intentFile);
        sentAt = intent.sent_at;
      } else {
        // Queue-empty gate before the next paid send.
        const pendingRows = (await db.execute(
          sql`select count(*)::int as n from pgboss.job where name=${FAMILY} and state in ('created','retry','active')`,
        )) as unknown as { n: number }[];
        const pending = pendingRows[0] ?? { n: 0 };
        if (pending.n > 0) {
          await writeStop(opts.outDir, 'queue_not_empty', { batch: batchN, pending: pending.n });
          stopped = 'queue_not_empty';
          break;
        }
        // Budget gate before enqueue: cumulative already over limit → stop.
        const cumulative = await loadCumulative(opts.outDir);
        if (cumulative.knownUsd > opts.thresholds.cumulativeUsd) {
          await writeStop(opts.outDir, 'cumulative_cost', {
            batch: batchN,
            cumulative_known_usd: cumulative.knownUsd,
          });
          stopped = 'cumulative_cost';
          break;
        }
        sentAt = new Date().toISOString();
        await writeFile(
          intentFile,
          JSON.stringify({ group_id: item.id, batch: batchN, index: idx, sent_at: sentAt }),
        );
        publishReceipt = await db.transaction(async (tx) => publishOne(tx, item));
        await writeFile(
          join(opts.outDir, `publish-${item.id}.json`),
          JSON.stringify({ at: sentAt, ...publishReceipt }, null, 2),
        );
      }

      // ── settle: poll DB until paid_effect + jobs are terminal ──
      const settleDeadline = Date.now() + opts.thresholds.settleTimeoutMs;
      let settled = false;
      let last = await snapshot(db, item.id, sentAt);
      while (Date.now() < settleDeadline) {
        last = await snapshot(db, item.id, sentAt);
        await writeFile(
          livePath(opts.outDir, item.id),
          JSON.stringify({ at: new Date().toISOString(), ...last }, null, 2),
        );
        const paidTerminal =
          last.paid.length > 0 && last.paid.every((row) => TERMINAL_PAID_STATES.has(row.state));
        const jobsTerminal =
          last.jobs.length > 0 && last.jobs.every((job) => TERMINAL_JOB_STATES.has(job.state));
        if (paidTerminal && jobsTerminal) {
          settled = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, opts.thresholds.pollMs));
      }

      const runs = last.runs.map((run) => {
        const http = parseProviderHttpError(run.error_message);
        return {
          ...run,
          http_error: http,
          ...(http.kind === 'parsed' ? { http_status: http.http_status } : {}),
        };
      });
      const paidRow = last.paid.find((row) => row.unit === PAID_UNIT) ?? last.paid[0];
      // The paid-effect failure detail lives in unresolved_reason (not
      // last_error — the sealed window's wrong-field read is why the first
      // round summarized null reasons).
      const unresolvedReason = paidRow?.unresolved_reason ?? null;
      const unresolvedHttp = parseProviderHttpError(unresolvedReason);
      const resultJson = paidRow?.result_json;
      const result =
        resultJson !== null && resultJson !== undefined && typeof resultJson === 'object'
          ? (resultJson as { result?: { status?: string; reason?: string } }).result
          : undefined;
      const unknownCostRunIds = runs.filter((run) => run.cost_usd === null).map((run) => run.id);
      const costKnownUsd = runs.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0);

      const alarms: string[] = [];
      for (const run of runs) {
        if (
          run.http_error.kind === 'parsed' &&
          run.http_error.http_status >= 400 &&
          run.http_error.http_status < 500
        ) {
          alarms.push(`provider_http_${run.http_error.http_status}`);
        } else if (run.http_error.kind === 'ambiguous') {
          alarms.push(`provider_http_parse_ambiguous:${run.http_error.detail}`);
        }
      }
      if (
        unresolvedHttp.kind === 'parsed' &&
        unresolvedHttp.http_status >= 400 &&
        unresolvedHttp.http_status < 500
      ) {
        alarms.push(`provider_http_${unresolvedHttp.http_status}`);
      } else if (unresolvedHttp.kind === 'ambiguous') {
        alarms.push(`provider_http_parse_ambiguous:${unresolvedHttp.detail}`);
      }
      if (!settled) alarms.push('settle_timeout');

      const cumulative = await loadCumulative(opts.outDir);
      const cumulativeKnown = cumulative.knownUsd + costKnownUsd;
      const cumulativeUnknownCalls = cumulative.unknownCalls + unknownCostRunIds.length;

      const receipt: ItemReceipt = {
        group_id: item.id,
        batch: batchN,
        index: idx,
        started_at: sentAt,
        finished_at: new Date().toISOString(),
        ...(publishReceipt ? { publish: publishReceipt } : {}),
        paid_state: paidRow?.state ?? 'missing',
        unresolved_reason: unresolvedReason,
        outcome:
          paidRow?.state === 'unknown'
            ? 'unknown'
            : ((result?.status as string | undefined) ?? null),
        reason: (result?.reason as string | undefined) ?? null,
        cost_known_usd: costKnownUsd,
        unknown_cost_run_ids: unknownCostRunIds,
        runs,
        jobs: last.jobs,
        alarms,
        settle_timeout: !settled,
        thresholds: opts.thresholds,
        pre_c6_note: PRE_C6_NOTE,
      };
      receipt.alarms = [
        ...alarms,
        ...evaluateQuestion(
          receipt,
          cumulativeKnown,
          cumulativeUnknownCalls,
          opts.thresholds,
          expectedPairs,
        ),
      ];
      await writeFile(receiptFile, JSON.stringify(receipt, null, 2));
      stats.items.push(`${item.id}:${receipt.paid_state}/${receipt.outcome ?? 'none'}`);
      stats.knownUsd += costKnownUsd;
      stats.unknownCalls += unknownCostRunIds.length;
      if (receipt.paid_state === 'unknown') stats.unknown += 1;

      if (receipt.alarms.length > 0) {
        await writeStop(opts.outDir, 'guardrail', {
          batch: batchN,
          group_id: item.id,
          alarms: receipt.alarms,
          current_job_may_be_settling: !settled,
        });
        stopped = 'guardrail';
        break;
      }
    }

    // Batch-close invariants + unknown-rate guardrail.
    const closeViolations = await checkInvariants(db, baseline, manifestIds);
    if (closeViolations.length > 0 && stopped === undefined) {
      await writeStop(opts.outDir, 'invariant_violation', {
        batch: batchN,
        violations: closeViolations,
      });
      stopped = 'invariant_violation';
    }
    // Unknown-rate guardrail counts EVERY receipted item of this batch slice —
    // including ones settled by an earlier (interrupted) run of the same batch.
    let batchProcessed = 0;
    let batchUnknown = 0;
    for (const item of items) {
      const file = receiptPath(opts.outDir, item.id);
      if (!(await fileExists(file))) continue;
      batchProcessed += 1;
      const settled = await readJson<ItemReceipt>(file);
      if (settled.paid_state === 'unknown') batchUnknown += 1;
    }
    if (
      stopped === undefined &&
      batchProcessed > 0 &&
      batchUnknown > batchProcessed * opts.thresholds.maxUnknownRate
    ) {
      await writeStop(opts.outDir, 'unknown_rate', {
        batch: batchN,
        unknown: batchUnknown,
        processed: batchProcessed,
        rate: opts.thresholds.maxUnknownRate,
      });
      stopped = 'unknown_rate';
    }

    const batchReceipt = {
      batch: batchN,
      status: stopped === undefined ? 'passed' : 'stopped',
      stopped_by: stopped ?? null,
      processed: stats.items,
      counts: {
        sent_this_run: stats.items.filter((e) => !e.endsWith(':already-settled')).length,
        processed: batchProcessed,
        unknown: batchUnknown,
        batch_known_usd: stats.knownUsd,
        batch_unknown_calls: stats.unknownCalls,
      },
      invariant_violations: closeViolations,
      thresholds: opts.thresholds,
      cumulative: await loadCumulative(opts.outDir),
      written_at: new Date().toISOString(),
    };
    await writeFile(batchFile, JSON.stringify(batchReceipt, null, 2));
    console.log(
      `batch ${batchN}: ${batchReceipt.status} (${stats.items.length} items, known $${stats.knownUsd.toFixed(6)}, unknown calls ${stats.unknownCalls})`,
    );
    if (stopped !== undefined) {
      throw new Error(`stopped: ${stopped} — see ${stopPath(opts.outDir)}`);
    }
  }
}

// ─── check (read-only eligibility) ──────────────────────────────────────────

async function check(manifestPath: string, groupId: string): Promise<void> {
  const db = await dbBoot();
  const manifest = await readJson(manifestPath, manifestSchema);
  const item = manifest.find((entry) => entry.id === groupId);
  if (!item) throw new Error(`manifest has no item ${groupId}`);
  const failures = await db.transaction(async (tx) => eligibilityFailure(tx, item));
  console.log(
    JSON.stringify(
      failures.length === 0 ? { ok: true, group_id: groupId } : { ok: false, failures },
      null,
      2,
    ),
  );
  if (failures.length > 0) process.exitCode = 1;
}

// ─── cli ────────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = 'true';
      }
    }
  }
  return flags;
}

function thresholdsFromFlags(flags: Record<string, string>): Thresholds {
  const num = (key: string, fallback: number): number => {
    const raw = flags[key];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--${key} must be a positive finite number, got '${raw}'`);
    }
    return parsed;
  };
  return {
    batchSize: Math.floor(num('batch-size', DEFAULTS.batchSize)),
    perQuestionUsd: num('per-question-usd', DEFAULTS.perQuestionUsd),
    cumulativeUsd: num('cumulative-usd', DEFAULTS.cumulativeUsd),
    hardCapUsd: num('hard-cap-usd', DEFAULTS.hardCapUsd),
    unknownReserveUsd: num('unknown-reserve-usd', DEFAULTS.unknownReserveUsd),
    maxUnknownRate: num('max-unknown-rate', DEFAULTS.maxUnknownRate),
    pollMs: Math.floor(num('poll-ms', DEFAULTS.pollMs)),
    settleTimeoutMs: Math.floor(num('settle-timeout-ms', DEFAULTS.settleTimeoutMs)),
  };
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const positional = rest.filter(
  (arg) => !arg.startsWith('--') && !Object.values(flags).includes(arg),
);

const run =
  command === 'check' && flags.manifest && positional.length === 1
    ? check(flags.manifest, positional[0])
    : command === 'drive' && flags.manifest && flags.out
      ? drive({
          manifestPath: flags.manifest,
          outDir: flags.out,
          ...(flags.batch !== undefined ? { batch: Number(flags.batch) } : {}),
          thresholds: thresholdsFromFlags(flags),
          ...(flags['preflight-receipt'] !== undefined
            ? { preflightReceipt: flags['preflight-receipt'] }
            : {}),
          ...(flags.sent !== undefined ? { sentIdsPath: flags.sent } : {}),
        })
      : Promise.reject(
          new Error(
            'usage: check --manifest <m.json> <group_id> | drive --manifest <m.json> --out <dir> --preflight-receipt <r.json> [--batch N] [--batch-size 20] [--per-question-usd 0.03] [--cumulative-usd 1] [--hard-cap-usd 3] [--unknown-reserve-usd 0.01] [--max-unknown-rate 0.1] [--sent ids.json]',
          ),
        );

run
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await dbHandle?.$client.end().catch(() => {});
  });
