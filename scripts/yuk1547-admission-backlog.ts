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
 *   - Runs are attributed to a send ONLY through the paid receipt's canonical
 *     ids — `result_json.result.evidence_refs.task_run_ids` (applied /
 *     receipt_ready) or the trailing `;task_runs=<csv>` marker inside
 *     `unresolved_reason` (unknown) — never by task_kind + start time. The
 *     paid row / job is itself bound by (question, revision,
 *     admission_generation, paid unit); with no bound row or explicit ids the
 *     send stays unattributed/pending-settlement and foreign-window run cost
 *     is never written into the question's receipt.
 *   - The queue gate checks BOTH non-terminal `question_admission_run`
 *     pg-boss jobs AND unsettled `practice.question-admission-enqueue`
 *     subscription deliveries (a pending delivery is pre-job paid work). A
 *     delivery not emitted by this window — matched by persistent event
 *     identity (event_id recorded at publish, or the payload
 *     group_id/revision_id/admission_generation triple, never actor_ref or
 *     time) — blocks the next send. Lookup failures never read as
 *     queue-empty.
 *   - Post-#1816, the paid apply publishes the resolved contract on
 *     admitted and emits its OWN publish event/delivery (job actor, send
 *     generation + 1). The gate recognizes that derivative ONLY through
 *     the paid identity chain in the same SQL snapshot — bound applied @3
 *     paid row (frozen input = the send's group/revision/generation) whose
 *     application_json records the event's revision/admission, plus the
 *     minted revision's published_by.paid_receipt leg for new-revision
 *     publishes — never by group, actor or time alone.
 *   - Manifests come in two shapes. The legacy array (112-window) is
 *     byte-compatible and keeps the hard web_sourced/official checks. The
 *     versioned scoped shape {version:1, scope:{...}, items:[...]}
 *     additionally binds each item's expected question.source and
 *     marking_provenance (plus optional declared state) against the live
 *     DB row — strict equality, no skip/bypass flag, no widened runnable
 *     states — and scopes the publish actor + receipts to the cohort
 *     identity instead of the 112 actor string (scope.actor_ref may be any
 *     value EXCEPT the reserved job actor 'practice:question_admission',
 *     which is rejected at parse — a send under it would be skipped by the
 *     enqueue handler and settle_timeout-STOP with the group withheld).
 *   - Already-sent items are explicit: --sent lists ids that must NOT appear in
 *     the manifest (overlap is a hard error — unknown/paid rows never replay).
 *   - Old paid_effect rows and preexisting withheld lifecycle rows are
 *     snapshotted into baseline.json at window start and re-verified every
 *     batch; new unknown rows may only resolve via the reconciler, and a
 *     baseline 'applied' row changing is an invariant violation.
 *   - Thresholds are explicit CLI config (defaults = approved values) and are
 *     recorded in baseline + every receipt.
 *   - The historical B spend ledger (--ledger) is REQUIRED and digest-pinned
 *     in baseline.json: cumulative $1 / hard-cap $3 apply to ledger+window
 *     merged totals, never to a fresh out-dir alone. entries[] carry per-run
 *     identity (dedupe: a run is never charged twice) and may carry per-run
 *     reserve bounds; the total unknown_reserve_usd must cover them. The
 *     preflight's own requests (incl. landing turns) must already be folded
 *     into the ledger before the first drive — nothing is charged at zero.
 *     Resume re-ajudicates every settled receipt (alarms/timeout) before any
 *     further enqueue.
 *
 * Ledger schema (the frozen prior-B artifact — e.g.
 * review/stage1-yuk1547-ledger-20261019/prior-b-ledger.verified.json — plus
 * the preflight's own requests folded in before the first drive):
 *   { "version": <int>, "scope": "...", "generated_at": "...",
 *     "known_usd_estimated": "<decimal>", "unknown_reserve_usd": "<decimal>",
 *     "unknown_cost_calls": <int>, "counted_run_ids": [<id>...],
 *     "entries": [ {"run_id": "<id>", "cost_usd": "<decimal>"|null,
 *                  "unknown_reserve_usd": "<decimal>"?, ...} ...] }
 * Money is decimal strings parsed with Number(); extra artifact fields are
 * passed through. Consistency is enforced: unknown entries ==
 * unknown_cost_calls, per-entry reserves <= unknown_reserve_usd, no
 * duplicate run/count ids, totals finite non-negative.
 *
 * usage:
 *   tsx scripts/yuk1547-admission-backlog.ts check --manifest <m.json> <group_id>
 *   tsx scripts/yuk1547-admission-backlog.ts drive --manifest <m.json> --out <dir>
 *       --preflight-receipt <path> --ledger <history-ledger.json>
 *       [--batch N] [--batch-size 20]
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
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Provider } from '@/ai/task-spec';
import {
  ADMISSION_FAMILY,
  admissionJobId,
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
// The 112-window actor string stays for legacy array manifests only. Every
// window attribution in this driver binds by event_id / the (group, revision,
// admission_generation) triple / the paid input identity — never by actor_ref
// (verified: windowOwnedEvents, windowInFlightSends, the queue gate, and the
// settle binding all ignore it), so a scoped manifest may record its own
// truthful cohort actor without breaking reopen attribution. The enqueue
// subscriber only special-cases 'practice:question_admission'; any other
// actor with admission='withheld' still enqueues normally.
const LEGACY_ACTOR_REF = 'stage1:backlog_readmission_b_112_20261019';
const JOB_ACTOR_REF = 'practice:question_admission';
// The subscription that turns our publish event into the paid pg-boss job
// (src/capabilities/practice/manifest.ts — id 'practice.question-admission-enqueue').
// A non-terminal delivery row is paid work already owed; ALL versions of the
// subscriber id count (version bumps re-key rows, never settle them).
const ENQUEUE_SUBSCRIBER_ID = 'practice.question-admission-enqueue';
const PUBLISH_ACTION = 'experimental:assessment_publish';

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
/** A manifest row. Scoped manifests additionally REQUIRE per-item declared
 *  expectations (source / marking_provenance / optional state) — strict
 *  equality bindings checked against the live DB row at eligibility time.
 *  Legacy array rows carry none and keep the 112-window hard defaults. */
type ManifestItem = z.infer<typeof manifestItem> & {
  source?: string;
  marking_provenance?: string;
  state?: string;
};
const manifestArraySchema = z.array(manifestItem).nonempty();

/** Versioned explicit-scope manifest: {version: 1, scope: {...}, items: [...]}.
 *  Every item binds the expected question.source and the lifecycle evidence
 *  marking_provenance (plus the same id/version/revision/generation/digest
 *  legs as the legacy row). The whole parsed object — scope included — feeds
 *  the pinned manifest digest, so scope/actor/extra evidence fields are all
 *  bound byte-for-byte into baseline.json. */
const scopedManifestSchema = z
  .object({
    version: z.literal(1),
    scope: z
      .object({
        id: z.string().min(1),
        // The job actor is reserved: a send published under it is skipped
        // unconditionally by the enqueue handler (actor check), so no paid
        // job would ever start — settle_timeout then STOP with the group
        // left withheld. Reject at parse, before any baseline/intent/publish.
        actor_ref: z
          .string()
          .min(1)
          .refine((value) => value !== JOB_ACTOR_REF, {
            message: `scope.actor_ref '${JOB_ACTOR_REF}' is reserved for the admission job — omit actor_ref to publish as stage1:<scope.id>, or choose a non-reserved value`,
          })
          .optional(),
      })
      .passthrough(),
    items: z
      .array(
        manifestItem
          .extend({
            source: z.string().min(1),
            marking_provenance: z.string().min(1),
            state: z.string().min(1).optional(),
          })
          .passthrough(),
      )
      .nonempty(),
  })
  .passthrough();
type ManifestScope = z.infer<typeof scopedManifestSchema>['scope'];

interface ResolvedManifest {
  items: ManifestItem[];
  /** null = legacy array manifest — the 112-window shape, kept byte-exact
   *  for reopen compatibility (hard web_sourced/official + legacy actor). */
  scope: ManifestScope | null;
}

function parseManifest(parsed: unknown): ResolvedManifest {
  if (Array.isArray(parsed)) {
    return { items: manifestArraySchema.parse(parsed), scope: null };
  }
  const scoped = scopedManifestSchema.parse(parsed);
  return { items: scoped.items, scope: scoped.scope };
}

/** The actor this window's publish events record. Legacy manifests keep the
 *  112-window string byte-exact; scoped manifests record their own cohort
 *  identity (scope.actor_ref, else stage1:<scope.id>) so the durable event
 *  log never masquerades this cohort as the settled 112 window. */
function manifestActorRef(scope: ManifestScope | null): string {
  if (scope === null) return LEGACY_ACTOR_REF;
  return scope.actor_ref ?? `stage1:${scope.id}`;
}

/**
 * The fixed historical cost ledger this window must merge — supplied by the
 * operator, pinned by digest inside baseline.json, and REQUIRED (never
 * defaulted to zero): the $1 cumulative / $3 hard-cap guardrails apply to the
 * whole B effort, not to the new out-dir.
 */
const decimalString = z.string().regex(/^\d+(\.\d+)?$/);
const ledgerSchema = z
  .object({
    version: z.number().int(),
    scope: z.string().min(1),
    generated_at: z.string().min(1),
    /** Historical KNOWN spend (estimated when raw cost was never persisted —
     *  never silently exact). Decimal string, parsed to number. */
    known_usd_estimated: decimalString,
    /** Historical reserve for calls whose raw cost is unknown — recorded as
     *  RESERVE (each unknown call's existing upper bound), never merged into
     *  known spend and never recomputed from a uniform per-call rate. */
    unknown_reserve_usd: decimalString,
    unknown_cost_calls: z.number().int().nonnegative(),
    /** Run/request identities already counted in the totals — window
     *  receipts naming one are skipped so a call is never charged twice. */
    counted_run_ids: z.array(z.string().min(1)).default([]),
    /** Per-entry detail: run_id dedupe + per-call reserve bound. */
    entries: z
      .array(
        z
          .object({
            run_id: z.string().min(1),
            cost_usd: decimalString.nullable().optional(),
            unknown_reserve_usd: decimalString.nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
type Ledger = z.infer<typeof ledgerSchema>;

interface NormalizedLedger {
  knownUsd: number;
  reserveUsd: number;
  unknownCalls: number;
  counted: Set<string>;
  raw: Ledger;
}

function normalizeLedger(ledger: Ledger): NormalizedLedger {
  const counted = new Set(ledger.counted_run_ids);
  if (counted.size !== ledger.counted_run_ids.length) {
    throw new Error('ledger contains duplicate counted_run_ids');
  }
  const entryIds = new Set(ledger.entries.map((entry) => entry.run_id));
  if (entryIds.size !== ledger.entries.length) {
    throw new Error('ledger contains duplicate run_id entries');
  }
  const unknownEntries = ledger.entries.filter(
    (entry) => entry.cost_usd === null || entry.cost_usd === undefined,
  );
  if (unknownEntries.length !== ledger.unknown_cost_calls) {
    throw new Error(
      `ledger inconsistent: ${unknownEntries.length} unknown-cost entries != unknown_cost_calls ${ledger.unknown_cost_calls}`,
    );
  }
  const reserveUsd = Number(ledger.unknown_reserve_usd);
  const summedEntryReserve = unknownEntries.reduce(
    (sum, entry) => sum + Number(entry.unknown_reserve_usd ?? '0'),
    0,
  );
  if (summedEntryReserve > reserveUsd + 1e-12) {
    throw new Error(
      `ledger inconsistent: per-entry reserves ${summedEntryReserve} exceed unknown_reserve_usd ${reserveUsd}`,
    );
  }
  const knownUsd = Number(ledger.known_usd_estimated);
  if (
    !Number.isFinite(knownUsd) ||
    knownUsd < 0 ||
    !Number.isFinite(reserveUsd) ||
    reserveUsd < 0
  ) {
    throw new Error('ledger totals must be non-negative finite numbers');
  }
  return { knownUsd, reserveUsd, unknownCalls: ledger.unknown_cost_calls, counted, raw: ledger };
}

const countedRunIds = (ledger: NormalizedLedger) => ledger.counted;

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
const sha256File = async (path: string) =>
  `sha256:${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}`;

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
  // Declared-expectation binding: a scoped item's source/marking_provenance/
  // state must equal the live DB values byte-for-byte; legacy rows fall back
  // to the 112-window constants, so reopening an old manifest checks exactly
  // what the sealed window checked.
  const expectedSource = item.source ?? 'web_sourced';
  const expectedProvenance = item.marking_provenance ?? 'official';
  if (root.source !== expectedSource) {
    failures.push(`source mismatch: expected '${expectedSource}', saw '${root.source}'`);
  }
  if (!lifecycle) failures.push('lifecycle missing');
  if (lifecycle) {
    if (lifecycle.withdrawn) failures.push('withdrawn');
    if (lifecycle.suspended) failures.push('suspended');
    if (lifecycle.suspended !== item.suspended) {
      failures.push(
        `suspended flag differs from manifest: expected ${item.suspended}, saw ${lifecycle.suspended}`,
      );
    }
    if (lifecycle.scoring_admission_state !== 'admitted') failures.push('not admitted');
    if (item.state !== undefined && lifecycle.scoring_admission_state !== item.state) {
      failures.push(
        `state mismatch: expected '${item.state}', saw '${lifecycle.scoring_admission_state}'`,
      );
    }
    if (lifecycle.scoring_admission_evidence?.marking_provenance !== expectedProvenance) {
      failures.push(
        `marking_provenance mismatch: expected '${expectedProvenance}', saw '${lifecycle.scoring_admission_evidence?.marking_provenance ?? 'null'}'`,
      );
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
  if (lifecycle) {
    const expectedLifecycleUpdatedMs = manifestTimestampMs(item.lifecycle_updated_at);
    if (
      expectedLifecycleUpdatedMs !== undefined &&
      lifecycle.updated_at.getTime() !== expectedLifecycleUpdatedMs
    ) {
      failures.push('lifecycle updated_at changed');
    }
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
  /** Transactional-outbox id of the publish event this send emitted — the
   *  persistent source identity the queue gate owns deliveries by. Null on
   *  'skipped' (noop publishes emit no event). */
  event_id: string | null;
  /** The actor_ref written onto this send's publish event — the manifest
   *  scope's cohort identity, never borrowed from another window. */
  actor_ref: string;
}

async function publishOne(tx: Tx, item: ManifestItem, actorRef: string): Promise<PublishReceipt> {
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
    actorRef,
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
    event_id: result.status === 'admission_updated' ? result.event_id : null,
    actor_ref: actorRef,
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
  data: unknown;
}

interface SubscriptionEvidenceRow {
  event_id: string;
  actor_ref: string;
  event_outcome: string | null;
  event_created_at: string;
  admission_generation: string | null;
  subscriber_version: number | null;
  delivery_seq: string | null;
  delivery_status: string | null;
  attempt_count: number | null;
  last_error: string | null;
  discovered_at: string | null;
  completed_at: string | null;
}

/** The (question, revision, admission_generation) this send is bound to —
 *  publish receipt first (actual committed values), manifest item as the
 *  crash-resume fallback (publishOne asserts the two agree). */
function expectedSendIdentity(
  item: ManifestItem,
  publishReceipt: PublishReceipt | undefined,
): { revisionId: string; generation: number } {
  return {
    revisionId: publishReceipt?.revision_id ?? item.revision_id,
    generation: publishReceipt?.generation ?? item.generation + 1,
  };
}

async function snapshot(
  db: Db,
  item: ManifestItem,
  sentAtIso: string,
  expected: { revisionId: string; generation: number },
) {
  const { paid_effect, ai_task_runs } = await import('@/db/schema');
  const paid: PaidRow[] = await db
    .select()
    .from(paid_effect)
    .where(and(eq(paid_effect.family, FAMILY), eq(paid_effect.entity_id, item.id)));
  const jobs = (await db.execute(
    sql`select id,state,retry_count,created_on,completed_on,data from pgboss.job where name=${FAMILY} and data->>'question_id'=${item.id} order by created_on`,
  )) as unknown as JobRow[];
  // Candidate window only — forensic evidence for unattributed runs, NEVER
  // attribution. Canonical linkage comes from the bound paid receipt below.
  const candidate_runs: AiTaskRunRow[] = await db
    .select()
    .from(ai_task_runs)
    .where(
      and(eq(ai_task_runs.task_kind, TASK_KIND), gte(ai_task_runs.started_at, new Date(sentAtIso))),
    );
  // This send's publish event → enqueue-subscription delivery, bound by the
  // payload (group, revision, generation) triple — a triple identifies one
  // publish act (each publish bumps generation); actor_ref is never used
  // because it is reused across windows.
  const subscription = (await db.execute(sql`
    select e.id as event_id, e.actor_ref, e.outcome as event_outcome,
           e.created_at as event_created_at,
           e.payload->>'admission_generation' as admission_generation,
           d.subscriber_version, d.delivery_seq::text as delivery_seq,
           d.status as delivery_status, d.attempt_count, d.last_error,
           d.discovered_at, d.completed_at
    from event e
    left join event_subscription_delivery d
      on d.subscriber_id = ${ENQUEUE_SUBSCRIBER_ID}
     and d.source_event_id = e.id
    where e.action = ${PUBLISH_ACTION}
      and e.payload->>'group_id' = ${item.id}
      and e.payload->>'revision_id' = ${expected.revisionId}
      and e.payload->>'admission_generation' = ${String(expected.generation)}
    order by e.created_at
  `)) as unknown as SubscriptionEvidenceRow[];
  return { paid, jobs, candidate_runs, subscription };
}

/** paid rows bound to THIS send: unit @3 + frozen input carrying the exact
 *  (group, revision, admission_generation) identity — never the bare group id
 *  (legacy @1/@2 units and other generations stay out). */
function boundPaidRows(
  paid: PaidRow[],
  item: ManifestItem,
  expected: { revisionId: string; generation: number },
): PaidRow[] {
  return paid.filter((row) => {
    if (row.unit !== PAID_UNIT) return false;
    const input = row.input_json as {
      group_id?: unknown;
      revision_id?: unknown;
      admission_generation?: unknown;
    } | null;
    return (
      input?.group_id === item.id &&
      input?.revision_id === expected.revisionId &&
      input?.admission_generation === expected.generation
    );
  });
}

/** The producer's canonical failure-side run list: `markPaidEffectUnknown`
 *  appends `;task_runs=<csv>` at the END of unresolved_reason (see
 *  question_admission_run.ts markPaidEffectUnknown calls). lastIndexOf is the
 *  producer marker — it is appended after any message text. */
function parseTaskRunsMarker(text: string | null | undefined): {
  present: boolean;
  ids: string[];
} {
  if (!text) return { present: false, ids: [] };
  const markerAt = text.lastIndexOf('task_runs=');
  if (markerAt < 0) return { present: false, ids: [] };
  const csv = text
    .slice(markerAt + 'task_runs='.length)
    .split(';')[0]
    .trim();
  if (csv === '') return { present: true, ids: [] };
  return {
    present: true,
    ids: csv
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  };
}

const paidReceiptEvidence = z
  .object({
    result: z
      .object({
        evidence_refs: z.object({ task_run_ids: z.array(z.string()) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/** Canonical task-run ids for ONE bound paid row — applied/receipt_ready read
 *  result_json.result.evidence_refs.task_run_ids (AdmissionResultReceipt);
 *  unknown reads the trailing task_runs= marker. Every extraction problem is
 *  an issue, never silent. */
function boundRunIds(row: PaidRow): {
  sources: { source: 'result_json' | 'unresolved_reason'; ids: string[] }[];
  issues: string[];
} {
  const sources: { source: 'result_json' | 'unresolved_reason'; ids: string[] }[] = [];
  const issues: string[] = [];
  const rowRef = `${row.unit}/${row.input_digest}`;
  if (row.result_json != null) {
    const parsed = paidReceiptEvidence.safeParse(row.result_json);
    if (!parsed.success) {
      issues.push(`${rowRef} result_json evidence_refs.task_run_ids unparseable`);
    } else {
      sources.push({ source: 'result_json', ids: parsed.data.result.evidence_refs.task_run_ids });
    }
  }
  if (row.state === 'unknown') {
    const marker = parseTaskRunsMarker(row.unresolved_reason);
    if (!marker.present) {
      issues.push(`${rowRef} unknown unresolved_reason has no task_runs= marker`);
    } else {
      const malformed = marker.ids.filter((id) => !/^[a-z0-9]+$/i.test(id));
      if (malformed.length > 0) {
        issues.push(`${rowRef} task_runs= carries malformed ids: ${malformed.join(',')}`);
      }
      sources.push({
        source: 'unresolved_reason',
        ids: marker.ids.filter((id) => /^[a-z0-9]+$/i.test(id)),
      });
    }
  }
  return { sources, issues };
}

const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_PAID_STATES = new Set(['applied', 'unknown']);

// ─── baselines / invariants ─────────────────────────────────────────────────

interface Baseline {
  created_at: string;
  manifest_sha256: string;
  manifest_count: number;
  /** The scoped manifest's scope object verbatim (null on legacy array
   *  manifests) + the publish actor this window resolved — the cohort
   *  identity every receipt and publish event records truthfully. Absent on
   *  baselines written before the scoped protocol; old windows resume
   *  without it because nothing reads it back. */
  manifest_scope?: ManifestScope | null;
  actor_ref?: string;
  sent_ids: string[];
  thresholds: Thresholds;
  expected_routes: { solverA: ExpectedRoute; solverB: ExpectedRoute };
  policy_id: string;
  config_epoch: number;
  ledger: {
    path: string;
    sha256: string;
    source: string;
    known_usd: number;
    unknown_reserve_usd: number;
    entries: number;
  };
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

// ─── enqueue-subscription queue gate ────────────────────────────────────────

/** Persistent event identity of THIS window's sends: event ids recorded in
 *  publish receipts, plus the payload (group, revision, generation) triple —
 *  unique per publish act — for receipts written before event_id existed.
 *  actor_ref is deliberately never part of the match. */
interface OwnedPublishEvents {
  eventIds: Set<string>;
  tripleKeys: Set<string>;
  /** The (group, revision, generation) send identities tripleKeys encodes, in
   *  structured form for the derivative-event binding leg: the paid apply's
   *  own publish emits on generation+1, so triples alone cannot name it. */
  sends: { groupId: string; revisionId: string; generation: number }[];
}

const publishTripleKey = (groupId: string, revisionId: string, generation: number) =>
  `${groupId}|${revisionId}|${generation}`;

const publishFileRecord = z
  .object({
    group_id: z.string(),
    revision_id: z.string().nullable(),
    generation: z.number().int().nonnegative(),
    event_id: z.string().nullable().optional(),
  })
  .passthrough();

/** Expected publish identity for an intent-persisted send: the publish file's
 *  committed values when present, else manifest-derived (publishOne asserts
 *  they agree). */
async function intentExpectedIdentity(
  outDir: string,
  item: ManifestItem,
): Promise<{ revisionId: string; generation: number }> {
  const path = join(outDir, `publish-${item.id}.json`);
  if (await fileExists(path)) {
    const record = publishFileRecord.parse(await readJson(path));
    if (record.revision_id !== null) {
      return { revisionId: record.revision_id, generation: record.generation };
    }
  }
  return { revisionId: item.revision_id, generation: item.generation + 1 };
}

/** The minimal owned-event set, built from the window's own artifacts:
 *  publish-<id>.json files plus the embedded publish receipt inside
 *  question-<id>.json (crash/resume coverage), plus intent-persisted sends
 *  without a publish record (crash between tx commit and file write). An
 *  intent-derived (group, revision, generation) triple still names this
 *  window's send — generation uniqueness makes the triple one publish act,
 *  and owning it only admits THIS item's own in-flight event/delivery; work
 *  for other groups never matches. */
async function windowOwnedEvents(
  outDir: string,
  manifestById: Map<string, ManifestItem>,
): Promise<OwnedPublishEvents> {
  const eventIds = new Set<string>();
  const tripleKeys = new Set<string>();
  const sendByKey = new Map<string, { groupId: string; revisionId: string; generation: number }>();
  const addSend = (groupId: string, revisionId: string, generation: number) => {
    const key = publishTripleKey(groupId, revisionId, generation);
    tripleKeys.add(key);
    sendByKey.set(key, { groupId, revisionId, generation });
  };
  for (const name of await readdir(outDir)) {
    if (/^intent-[^/]+\.json$/.test(name)) {
      const groupId = name.slice('intent-'.length, -'.json'.length);
      const item = manifestById.get(groupId);
      if (!item) continue;
      const expected = await intentExpectedIdentity(outDir, item);
      addSend(groupId, expected.revisionId, expected.generation);
      continue;
    }
    const isPublish = /^publish-[^/]+\.json$/.test(name);
    const isReceipt = /^question-[^/]+\.json$/.test(name);
    if (!isPublish && !isReceipt) continue;
    const parsed: unknown = await readJson(join(outDir, name));
    const candidates = isPublish ? [parsed] : [(parsed as { publish?: unknown }).publish];
    for (const candidate of candidates) {
      const record = publishFileRecord.safeParse(candidate);
      if (!record.success) continue;
      if (record.data.event_id) eventIds.add(record.data.event_id);
      if (record.data.revision_id !== null) {
        addSend(record.data.group_id, record.data.revision_id, record.data.generation);
      }
    }
  }
  return { eventIds, tripleKeys, sends: [...sendByKey.values()] };
}

/** Sends this window persisted (intent file) but never receipted — the
 *  in-flight identities whose own non-terminal jobs the WINDOW-OPEN gate may
 *  let through into the existing-intent settle path. New sends never see
 *  this exemption: their gate counts every non-terminal job. */
interface InFlightSend {
  groupId: string;
  revisionId: string;
  generation: number;
  /** Manifest revision integrity_digest — admissionJobId input. */
  digest: string;
}

async function windowInFlightSends(
  outDir: string,
  manifestById: Map<string, ManifestItem>,
): Promise<InFlightSend[]> {
  const sends: InFlightSend[] = [];
  for (const name of await readdir(outDir)) {
    if (!/^intent-[^/]+\.json$/.test(name)) continue;
    const groupId = name.slice('intent-'.length, -'.json'.length);
    if (await fileExists(receiptPath(outDir, groupId))) continue; // settled — not in-flight
    const item = manifestById.get(groupId);
    if (!item) continue; // not this window's manifest — cannot bind → foreign by default
    const expected = await intentExpectedIdentity(outDir, item);
    sends.push({
      groupId,
      revisionId: expected.revisionId,
      generation: expected.generation,
      digest: item.integrity_digest,
    });
  }
  return sends;
}

interface GateJobRow {
  id: string;
  state: string;
  retry_count: number;
  created_on: string;
  data: unknown;
}

interface GateDeliveryRow {
  subscriber_version: number;
  source_event_id: string;
  status: string;
  delivery_seq: number;
  attempt_count: number;
  next_attempt_at: string | null;
  claim_lease_until: string | null;
  last_error: string | null;
  discovered_at: string;
  event_id: string | null;
  actor_ref: string | null;
  event_outcome: string | null;
  event_created_at: string | null;
  group_id: string | null;
  revision_id: string | null;
  admission_generation: string | null;
}

interface GateEventRow {
  event_id: string;
  actor_ref: string | null;
  event_outcome: string | null;
  event_created_at: string;
  dispatch_seq: number;
  group_id: string | null;
  revision_id: string | null;
  admission_generation: string | null;
}

const GATE_EVIDENCE_LIMIT = 30;

/** jsonb columns arrive parsed via the driver; a string payload is parsed
 *  once, and anything else aborts the gate — a malformed read is never
 *  treated as queue-empty. */
function gateJsonColumn<T>(value: unknown, name: string): T[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new Error(`queue gate read malformed: ${name} is not an array`);
  }
  return parsed as T[];
}

/**
 * Queue-empty gate — non-terminal pgboss jobs AND unsettled enqueue
 * deliveries (incl. eligible publish events not yet discovered into delivery
 * rows), all read inside ONE SQL statement so they share a single READ
 * COMMITTED snapshot: discovery committing between separate reads must never
 * make all three look empty (scenario A), and a handler committing a job
 * plus a terminal delivery between them must never hide the job (scenario
 * B). Ownership resolves through persistent event identity only:
 * deliveries/events emitted by THIS window don't block; anything else does —
 * a row whose source event can't be resolved is foreign, and a failing query
 * aborts the driver instead of reading as queue-empty.
 *
 * Post-#1816 derivative recognition (paid apply now publishes the resolved
 * contract on admitted): the paid job's apply step emits its OWN publish
 * event — actor 'practice:question_admission', a freshly minted revision
 * (or a dimension_update on the bound one), admission_generation = send
 * generation + 1 — and the durable subscriber's discovery files a pending
 * delivery that the handler then settles to 'skipped' (the actor check can
 * never enqueue). That transient non-terminal delivery is THIS send's
 * derivative, not foreign work — but only when bound through the paid
 * identity chain, verified inside the same gate snapshot:
 *   event(group, revision_id, admission_generation=G+1, supersedes=R|absent,
 *         actor=practice:question_admission, outcome=success,
 *         admission = application status)
 *   = the applied @3 paid row whose frozen input is exactly (group, R, G)
 *     AND whose application_json records the event's revision/admission,
 *   and for new-revision publishes additionally the minted
 *   question_revision.published_by.paid_receipt binds the same paid row
 *   (unit + input_digest). The apply tx commits the event and
 *   application_json atomically, so a binding can never observe an event
 *   its application didn't record. Nothing is exempted by group, actor or
 *   time alone; a derivative delivery can never become paid work (the
 *   handler skips the job actor unconditionally), so owning it cannot
 *   swallow a real unsettled admission.
 *
 * `exemptJobs` (window-open only): non-terminal jobs bound — by the same
 * (group, revision, generation) identity the settle loop uses — to sends
 * this window already persisted (intent, no receipt). Those are not foreign
 * work; exempting them keeps the crash-resume path reachable instead of
 * writing a permanent STOP over our own in-flight send. Callers opening a
 * NEW send pass no exemptions: every non-terminal job still blocks.
 */
async function admissionQueueGate(
  db: Db,
  owned: OwnedPublishEvents,
  opts?: { exemptJobs?: InFlightSend[] },
): Promise<{ clear: boolean; evidence: Record<string, unknown> }> {
  const isOwned = (
    eventId: string,
    groupId: string | null,
    revisionId: string | null,
    generation: string | null,
  ) =>
    owned.eventIds.has(eventId) ||
    (groupId !== null &&
      revisionId !== null &&
      generation !== null &&
      owned.tripleKeys.has(publishTripleKey(groupId, revisionId, Number(generation))));
  const exemptJobs = opts?.exemptJobs ?? [];
  // The window's own send identities, bound into the derivative-recognition
  // subquery as data — the join re-derives each leg from paid_effect/event
  // rows inside the same statement, so the JSON is a filter, not evidence.
  const sendsJson = JSON.stringify(
    owned.sends.map((send) => ({
      group_id: send.groupId,
      revision_id: send.revisionId,
      admission_generation: send.generation,
    })),
  );
  const isExemptJob = (job: GateJobRow) =>
    exemptJobs.some((send) => {
      const data = job.data as {
        question_id?: unknown;
        revision_id?: unknown;
        expected_admission_generation?: unknown;
      } | null;
      return (
        job.id === admissionJobId(send.groupId, send.revisionId, send.digest, send.generation) ||
        (data?.question_id === send.groupId &&
          data?.revision_id === send.revisionId &&
          data?.expected_admission_generation === send.generation)
      );
    });
  const [row] = (await db.execute(sql`
    select
      coalesce((
        select jsonb_agg(t order by t.created_on)
        from (
          select j.id, j.state::text as state, j.retry_count, j.created_on, j.data
          from pgboss.job j
          where j.name = ${FAMILY} and j.state in ('created','retry','active')
        ) t
      ), '[]'::jsonb) as pending_jobs,
      coalesce((
        select jsonb_agg(t order by t.delivery_seq)
        from (
          select d.subscriber_version, d.source_event_id, d.status,
                 d.delivery_seq, d.attempt_count,
                 d.next_attempt_at, d.claim_lease_until, d.last_error, d.discovered_at,
                 e.id as event_id, e.actor_ref, e.outcome as event_outcome,
                 e.created_at as event_created_at,
                 e.payload->>'group_id' as group_id,
                 e.payload->>'revision_id' as revision_id,
                 e.payload->>'admission_generation' as admission_generation
          from event_subscription_delivery d
          left join event e
            on e.id = d.source_event_id and e.dispatch_seq = d.source_dispatch_seq
          where d.subscriber_id = ${ENQUEUE_SUBSCRIBER_ID}
            and d.status not in ('bootstrap_skipped','succeeded','skipped','dead_letter')
        ) t
      ), '[]'::jsonb) as deliveries,
      coalesce((
        select jsonb_agg(t order by t.dispatch_seq)
        from (
          select e.id as event_id, e.actor_ref, e.outcome as event_outcome,
                 e.created_at as event_created_at, e.dispatch_seq,
                 e.payload->>'group_id' as group_id,
                 e.payload->>'revision_id' as revision_id,
                 e.payload->>'admission_generation' as admission_generation
          from event e
          where e.action = ${PUBLISH_ACTION}
            and e.outcome = 'success'
            and e.actor_ref <> ${JOB_ACTOR_REF}
            and e.payload->>'admission' = 'withheld'
            and not exists (
              select 1 from event_subscription_delivery d
              where d.subscriber_id = ${ENQUEUE_SUBSCRIBER_ID}
                and d.source_event_id = e.id
            )
        ) t
      ), '[]'::jsonb) as undiscovered,
      -- Paid-apply derivative events (post-#1816): bound through the SAME
      -- snapshot to this window's sends by the applied @3 paid row's frozen
      -- input identity AND its application_json record — never by
      -- group/actor/time alone. The event and application_json commit in
      -- one tx, so the binding cannot name an event whose application is
      -- still unwritten; a send whose paid row is not yet applied derives
      -- nothing and its deliveries stay foreign.
      coalesce((
        select jsonb_agg(t.event_id)
        from (
          select distinct e.id as event_id
          from event e
          join jsonb_to_recordset(${sendsJson}::jsonb) as s(
            group_id text, revision_id text, admission_generation integer
          ) on s.group_id = e.payload->>'group_id'
          join paid_effect p
            on p.family = ${FAMILY}
           and p.entity_id = s.group_id
           and p.unit = ${PAID_UNIT}
           and p.state = 'applied'
           and p.input_json->>'group_id' = s.group_id
           and p.input_json->>'revision_id' = s.revision_id
           and (p.input_json->>'admission_generation')::int = s.admission_generation
           and p.application_json->>'revision_id' = e.payload->>'revision_id'
           and p.application_json->>'status' = e.payload->>'admission'
          where e.action = ${PUBLISH_ACTION}
            and e.outcome = 'success'
            and e.actor_ref = ${JOB_ACTOR_REF}
            and (e.payload->>'admission_generation')::int = s.admission_generation + 1
            and coalesce(e.payload->>'supersedes_revision_id', s.revision_id) = s.revision_id
            and (
              e.payload->>'dimension_update' is not null
              or exists (
                select 1 from question_revision r
                where r.revision_id = e.payload->>'revision_id'
                  and r.group_id = s.group_id
                  and r.published_by->'paid_receipt'->>'input_digest' = p.input_digest
                  and r.published_by->'paid_receipt'->>'unit' = p.unit
              )
            )
        ) t
      ), '[]'::jsonb) as derived_event_ids
  `)) as unknown as {
    pending_jobs: unknown;
    deliveries: unknown;
    undiscovered: unknown;
    derived_event_ids: unknown;
  }[];
  if (!row) throw new Error('queue gate read returned no row');
  const pendingJobRows = gateJsonColumn<GateJobRow>(row.pending_jobs, 'pending_jobs');
  const deliveries = gateJsonColumn<GateDeliveryRow>(row.deliveries, 'deliveries');
  const undiscovered = gateJsonColumn<GateEventRow>(row.undiscovered, 'undiscovered');
  const derivedEventIds = new Set(
    gateJsonColumn<string>(row.derived_event_ids, 'derived_event_ids'),
  );
  const foreignJobs = pendingJobRows.filter((job) => !isExemptJob(job));
  const ownInFlightJobs = pendingJobRows.filter(isExemptJob);
  const deliveryEvidence = deliveries.map((row) => ({
    source_event_id: row.source_event_id,
    subscriber_version: row.subscriber_version,
    delivery_seq: row.delivery_seq,
    status: row.status,
    attempt_count: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    claim_lease_until: row.claim_lease_until,
    last_error: row.last_error,
    discovered_at: row.discovered_at,
    event:
      row.event_id === null
        ? null
        : {
            id: row.event_id,
            actor_ref: row.actor_ref,
            outcome: row.event_outcome,
            created_at: row.event_created_at,
            group_id: row.group_id,
            revision_id: row.revision_id,
            admission_generation: row.admission_generation,
          },
    owned:
      isOwned(row.source_event_id, row.group_id, row.revision_id, row.admission_generation) ||
      derivedEventIds.has(row.source_event_id),
  }));
  const foreignDeliveries = deliveryEvidence.filter((row) => !row.owned);
  const undiscoveredEvidence = undiscovered.map((row) => ({
    ...row,
    owned:
      isOwned(row.event_id, row.group_id, row.revision_id, row.admission_generation) ||
      derivedEventIds.has(row.event_id),
  }));
  const foreignUndiscovered = undiscoveredEvidence.filter((row) => !row.owned);
  const evidence = {
    pending_jobs: pendingJobRows.length,
    foreign_pending_jobs: foreignJobs.length,
    own_inflight_jobs: ownInFlightJobs.length,
    pending_job_ids: foreignJobs.slice(0, GATE_EVIDENCE_LIMIT).map((job) => job.id),
    own_inflight_job_ids: ownInFlightJobs.map((job) => job.id),
    nonterminal_deliveries: deliveries.length,
    foreign_deliveries: foreignDeliveries.length,
    undiscovered_eligible_events: undiscovered.length,
    foreign_undiscovered_events: foreignUndiscovered.length,
    deliveries: foreignDeliveries.slice(0, GATE_EVIDENCE_LIMIT),
    undiscovered_events: foreignUndiscovered.slice(0, GATE_EVIDENCE_LIMIT),
    owned_event_ids: [...owned.eventIds],
    owned_triple_count: owned.tripleKeys.size,
    derived_event_ids: [...derivedEventIds],
  };
  return {
    clear:
      foreignJobs.length === 0 &&
      foreignDeliveries.length === 0 &&
      foreignUndiscovered.length === 0,
    evidence,
  };
}

// ─── receipt io ─────────────────────────────────────────────────────────────

const intentPath = (outDir: string, id: string) => join(outDir, `intent-${id}.json`);
const receiptPath = (outDir: string, id: string) => join(outDir, `question-${id}.json`);
const livePath = (outDir: string, id: string) => join(outDir, `live-${id}.json`);
const stopPath = (outDir: string) => join(outDir, 'STOP.json');
const batchPath = (outDir: string, n: number) => join(outDir, `batch-${n}-receipt.json`);
const baselinePath = (outDir: string) => join(outDir, 'baseline.json');

// Only ENOENT means "absent". Any other read failure (EACCES on an unreadable
// STOP.json, EISDIR, EIO, ...) must abort the driver rather than masquerade as
// "no file" — the 2026-10-18 incident sent two more paid questions because an
// EACCES on STOP.json was swallowed into false.
async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
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
  /** The manifest scope (verbatim; null on legacy windows) + resolved publish
   *  actor — the cohort identity this receipt answers for. */
  scope: ManifestScope | null;
  actor_ref: string;
  publish?: PublishReceipt;
  paid_state: string;
  unresolved_reason: string | null;
  outcome: string | null;
  reason: string | null;
  cost_known_usd: number;
  unknown_cost_run_ids: string[];
  /** Ledger-merged window totals at settle time (historical + this window,
   *  run-id deduped) — the denominators the budget alarms applied. Reserve is
   *  recorded separately: unknown cost is never merged into known spend. */
  cumulative_known_usd: number;
  cumulative_reserve_usd: number;
  /** Canonical-attributed runs ONLY (ids from the bound paid receipt) — the
   *  only runs ever charged to this question. */
  runs: (AiTaskRunRow & { http_status?: number; http_error?: HttpEvidence })[];
  /** Window-candidate runs NOT canonically linked to this send — forensics
   *  only, never charged, never evidence of completion. */
  unattributed_runs: (AiTaskRunRow & { http_status?: number; http_error?: HttpEvidence })[];
  jobs: JobRow[];
  /** This send's publish event → enqueue-subscription delivery evidence —
   *  why a settle_timeout waited (pending delivery ⇒ pre-job paid work). */
  subscription: SubscriptionEvidenceRow[];
  /** The (revision, generation, unit) identity this send settled against and
   *  where its canonical task-run ids came from. */
  attribution: {
    expected_revision_id: string;
    expected_admission_generation: number;
    expected_job_id: string;
    bound_paid_rows: {
      unit: string;
      entity_revision: string;
      input_digest: string;
      state: string;
    }[];
    run_id_sources: { source: 'result_json' | 'unresolved_reason'; ids: string[] }[];
    issues: string[];
  };
  alarms: string[];
  settle_timeout: boolean;
  thresholds: Thresholds;
  pre_c6_note: string;
}

const PRE_C6_NOTE =
  'Individual raw HTTP request payloads are not archived (pre-C6 evidence gap); ' +
  'route/native-params truth is the resolved binding + task_run provider/model columns.';

/**
 * Scan every settled question receipt in the window: ledger-merged cumulative
 * cost (deduped by counted_run_ids — a run is never charged twice), plus the
 * receipts' own alarm/timeout verdicts re-read for resume safety — a written
 * receipt is never treated as passed just because it exists.
 */
async function auditWindowReceipts(
  outDir: string,
  ledger: NormalizedLedger,
  unknownReserveUsd: number,
): Promise<{
  knownUsd: number;
  reserveUsd: number;
  unknownCalls: number;
  unknownQuestions: number;
  processed: number;
  violations: string[];
}> {
  const counted = countedRunIds(ledger);
  const files = (await readdir(outDir)).filter((name) => /^question-[^/]+\.json$/.test(name));
  let windowKnown = 0;
  let windowUnknownCalls = 0;
  let unknownQuestions = 0;
  const violations: string[] = [];
  for (const name of files) {
    const receipt = await readJson<ItemReceipt>(join(outDir, name));
    for (const run of receipt.runs) {
      if (counted.has(run.id)) continue;
      if (run.cost_usd === null) windowUnknownCalls += 1;
      else windowKnown += run.cost_usd;
    }
    if (receipt.paid_state === 'unknown') unknownQuestions += 1;
    if (receipt.alarms.length > 0 || receipt.settle_timeout) {
      violations.push(
        `${receipt.group_id}: settled receipt carries unresolved guardrail evidence ` +
          `(alarms=[${receipt.alarms.join(',')}] settle_timeout=${receipt.settle_timeout})`,
      );
    }
  }
  return {
    knownUsd: ledger.knownUsd + windowKnown,
    // Historical reserve carries its own per-run bounds verbatim; only THIS
    // window's unknown calls are priced at the configured new-window reserve.
    reserveUsd: ledger.reserveUsd + windowUnknownCalls * unknownReserveUsd,
    unknownCalls: windowUnknownCalls,
    unknownQuestions,
    processed: files.length,
    violations,
  };
}

/** Batch unknown tally over the PLANNED batch slice — the denominator rule is
 *  `unknown > items.length * maxUnknownRate` against the full planned batch,
 *  so a partly-settled batch cannot dilute an overrun. */
async function countBatchReceipts(
  outDir: string,
  items: ManifestItem[],
): Promise<{ processed: number; unknown: number }> {
  let processed = 0;
  let unknown = 0;
  for (const item of items) {
    const file = receiptPath(outDir, item.id);
    if (!(await fileExists(file))) continue;
    processed += 1;
    const receipt = await readJson<ItemReceipt>(file);
    if (receipt.paid_state === 'unknown') unknown += 1;
  }
  return { processed, unknown };
}

function evaluateQuestion(
  receipt: Pick<ItemReceipt, 'runs' | 'cost_known_usd'>,
  cumulativeKnownUsd: number,
  cumulativeReserveUsd: number,
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
  const boundedTotal = cumulativeKnownUsd + cumulativeReserveUsd;
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
  ledgerPath: string;
  sentIdsPath?: string;
}): Promise<void> {
  const db = await dbBoot();
  const manifestRaw = await readJson(opts.manifestPath);
  const { items: manifest, scope: manifestScope } = parseManifest(manifestRaw);
  // Digest compat: a legacy array manifest is hashed AFTER zod-strip, exactly
  // as the sealed 112 window computed it — reopening compares equal. The
  // scoped shape instead pins the whole parsed input (scope, actor and every
  // passthrough evidence field included), the strict superset binding.
  const manifestDigest = manifestScope === null ? sha256(manifest) : sha256(manifestRaw);
  const actorRef = manifestActorRef(manifestScope);
  // The historical B ledger is mandatory input — never default to zero; its
  // FILE digest is pinned into baseline.json and must match on every later
  // run (hashing raw bytes so the operator's frozen artifact is pinned
  // byte-for-byte, not by post-parse key order).
  const ledger = normalizeLedger(await readJson(opts.ledgerPath, ledgerSchema));
  const ledgerDigest = await sha256File(opts.ledgerPath);
  const manifestIds = new Set(manifest.map((item) => item.id));
  if (manifestIds.size !== manifest.length) throw new Error('manifest contains duplicate ids');
  const manifestById = new Map(manifest.map((item) => [item.id, item]));
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
      manifest_scope: manifestScope,
      actor_ref: actorRef,
      sent_ids: sentIds,
      thresholds: opts.thresholds,
      expected_routes: routes,
      policy_id: policy,
      config_epoch: configEpoch,
      ledger: {
        path: opts.ledgerPath,
        sha256: ledgerDigest,
        source: ledger.raw.scope,
        known_usd: ledger.knownUsd,
        unknown_reserve_usd: ledger.reserveUsd,
        entries: ledger.counted.size,
      },
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
    if (baseline.ledger.sha256 !== ledgerDigest) {
      throw new Error(
        `ledger digest mismatch — baseline pins ${baseline.ledger.sha256} (${baseline.ledger.path})`,
      );
    }
  }

  // Window-open queue gate — before ANY send (incl. resumed windows): a
  // foreign non-terminal delivery is pre-job paid work already owed. The
  // 2026-10-18 incident's sourcing_web deliveries sat exactly here while the
  // jobs-only check passed. Jobs bound to this window's own intent-persisted
  // sends are NOT foreign — exempting them lets a crash-resumed in-flight
  // send reach its existing-intent settle instead of a permanent STOP.
  {
    const owned = await windowOwnedEvents(opts.outDir, manifestById);
    const inFlight = await windowInFlightSends(opts.outDir, manifestById);
    const gate = await admissionQueueGate(db, owned, { exemptJobs: inFlight });
    if (!gate.clear) {
      await writeStop(opts.outDir, 'queue_not_empty', { at: 'window_open', ...gate.evidence });
      throw new Error(
        `window-open queue gate: foreign unsettled admission work — see ${stopPath(opts.outDir)}`,
      );
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

    // Batch-open invariant check against the window baseline, then re-audit
    // every already-settled receipt — a crash between receipt write and STOP
    // write must not resume past a recorded guardrail breach.
    const openViolations = await checkInvariants(db, baseline, manifestIds);
    if (openViolations.length > 0) {
      await writeStop(opts.outDir, 'invariant_violation', {
        batch: batchN,
        violations: openViolations,
      });
      throw new Error(`batch ${batchN} open invariants: ${openViolations.join('; ')}`);
    }
    const settledAudit = await auditWindowReceipts(
      opts.outDir,
      ledger,
      opts.thresholds.unknownReserveUsd,
    );
    if (settledAudit.violations.length > 0) {
      await writeStop(opts.outDir, 'carried_guardrail', {
        batch: batchN,
        violations: settledAudit.violations,
      });
      throw new Error(
        `batch ${batchN} carried guardrail violations: ${settledAudit.violations.join('; ')}`,
      );
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
        // never replay — resume skips the settled item, but a receipt is not a
        // pass: re-ajudicate its recorded alarms/timeout before moving on so a
        // crash between receipt write and STOP write cannot continue sending.
        const settled = await readJson<ItemReceipt>(receiptFile);
        if (settled.alarms.length > 0 || settled.settle_timeout) {
          await writeStop(opts.outDir, 'carried_guardrail', {
            batch: batchN,
            group_id: item.id,
            alarms: settled.alarms,
            settle_timeout: settled.settle_timeout,
          });
          stopped = 'carried_guardrail';
          break;
        }
        stats.items.push(`${item.id}:already-settled`);
        continue;
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
        // Queue-empty gate before the next paid send: non-terminal jobs AND
        // unsettled enqueue-subscription deliveries not emitted by this
        // window — a pending delivery is paid work already owed. NO job
        // exemptions here: every non-terminal job (ours included) blocks a
        // NEW publish.
        const gate = await admissionQueueGate(
          db,
          await windowOwnedEvents(opts.outDir, manifestById),
        );
        if (!gate.clear) {
          await writeStop(opts.outDir, 'queue_not_empty', {
            batch: batchN,
            group_id: item.id,
            ...gate.evidence,
          });
          stopped = 'queue_not_empty';
          break;
        }
        // Unknown-rate gate before EVERY enqueue: recomputed against the
        // planned batch denominator, so once an overrun is unrecoverable the
        // next question is never sent (e.g. 3rd unknown in a 20-item batch).
        const batchTally = await countBatchReceipts(opts.outDir, items);
        if (batchTally.unknown > items.length * opts.thresholds.maxUnknownRate) {
          await writeStop(opts.outDir, 'unknown_rate', {
            batch: batchN,
            unknown: batchTally.unknown,
            denominator: `planned_batch_items=${items.length}`,
            rate: opts.thresholds.maxUnknownRate,
          });
          stopped = 'unknown_rate';
          break;
        }
        // Budget gate before enqueue — ledger-merged totals, never
        // window-local zero: cumulative >$1 stops, and the hard cap counts
        // unknown cost at its recorded reserve, not at zero.
        const cumulative = await auditWindowReceipts(
          opts.outDir,
          ledger,
          opts.thresholds.unknownReserveUsd,
        );
        if (cumulative.violations.length > 0) {
          await writeStop(opts.outDir, 'carried_guardrail', {
            batch: batchN,
            violations: cumulative.violations,
          });
          stopped = 'carried_guardrail';
          break;
        }
        if (cumulative.knownUsd > opts.thresholds.cumulativeUsd) {
          await writeStop(opts.outDir, 'cumulative_cost', {
            batch: batchN,
            cumulative_known_usd: cumulative.knownUsd,
          });
          stopped = 'cumulative_cost';
          break;
        }
        const bounded = cumulative.knownUsd + cumulative.reserveUsd;
        if (bounded > opts.thresholds.hardCapUsd) {
          await writeStop(opts.outDir, 'hard_cap', {
            batch: batchN,
            bounded_total_usd: bounded,
          });
          stopped = 'hard_cap';
          break;
        }
        sentAt = new Date().toISOString();
        await writeFile(
          intentFile,
          JSON.stringify({ group_id: item.id, batch: batchN, index: idx, sent_at: sentAt }),
        );
        publishReceipt = await db.transaction(async (tx) => publishOne(tx, item, actorRef));
        await writeFile(
          join(opts.outDir, `publish-${item.id}.json`),
          JSON.stringify({ at: sentAt, ...publishReceipt }, null, 2),
        );
      }

      // ── settle: poll DB until THIS send's paid row + job are terminal ──
      // Identity, not group history: the paid row is bound by (unit, frozen
      // input revision + admission_generation) and the job by
      // (question, revision, expected generation) — the job id is the same
      // deterministic admissionJobId the enqueue handler derives.
      const expected = expectedSendIdentity(item, publishReceipt);
      const expectedJobId = admissionJobId(
        item.id,
        expected.revisionId,
        item.integrity_digest,
        expected.generation,
      );
      const jobsForThisSend = (jobs: JobRow[]) =>
        jobs.filter((job) => {
          const data = job.data as {
            question_id?: unknown;
            revision_id?: unknown;
            expected_admission_generation?: unknown;
          } | null;
          return (
            job.id === expectedJobId ||
            (data?.question_id === item.id &&
              data?.revision_id === expected.revisionId &&
              data?.expected_admission_generation === expected.generation)
          );
        });
      const settleDeadline = Date.now() + opts.thresholds.settleTimeoutMs;
      let settled = false;
      let last = await snapshot(db, item, sentAt, expected);
      while (Date.now() < settleDeadline) {
        last = await snapshot(db, item, sentAt, expected);
        await writeFile(
          livePath(opts.outDir, item.id),
          JSON.stringify({ at: new Date().toISOString(), ...last }, null, 2),
        );
        const boundRows = boundPaidRows(last.paid, item, expected);
        const paidTerminal =
          boundRows.length > 0 && boundRows.every((row) => TERMINAL_PAID_STATES.has(row.state));
        const sendJobs = jobsForThisSend(last.jobs);
        const jobsTerminal =
          sendJobs.length > 0 && sendJobs.every((job) => TERMINAL_JOB_STATES.has(job.state));
        if (paidTerminal && jobsTerminal) {
          settled = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, opts.thresholds.pollMs));
      }

      const enrichRun = (run: AiTaskRunRow) => {
        const http = parseProviderHttpError(run.error_message);
        return {
          ...run,
          http_error: http,
          ...(http.kind === 'parsed' ? { http_status: http.http_status } : {}),
        };
      };
      // Canonical run ids from THIS send's bound paid rows only — applied /
      // receipt_ready carry result_json.result.evidence_refs.task_run_ids;
      // unknown carries the trailing ;task_runs=<csv> marker. With no bound
      // row / no explicit ids the send stays unattributed/pending-settlement:
      // it never masquerades as $0-paid or complete, and foreign-window runs
      // are never written into this question's cost.
      const boundRows = boundPaidRows(last.paid, item, expected);
      const runIdSources: { source: 'result_json' | 'unresolved_reason'; ids: string[] }[] = [];
      const attributionIssues: string[] = [];
      for (const row of boundRows) {
        const extracted = boundRunIds(row);
        runIdSources.push(...extracted.sources);
        attributionIssues.push(...extracted.issues);
      }
      const canonicalIds = new Set(runIdSources.flatMap((entry) => entry.ids));
      const { ai_task_runs } = await import('@/db/schema');
      const attributedRows =
        canonicalIds.size > 0
          ? await db
              .select()
              .from(ai_task_runs)
              .where(inArray(ai_task_runs.id, [...canonicalIds]))
          : [];
      const foundIds = new Set(attributedRows.map((run) => run.id));
      const alarms: string[] = [];
      for (const id of canonicalIds) {
        if (!foundIds.has(id)) alarms.push(`attribution:run_row_missing:${id}`);
      }
      for (const run of attributedRows) {
        if (run.task_kind !== TASK_KIND) {
          alarms.push(`attribution:run_task_kind_mismatch:${run.id}:${run.task_kind}`);
        }
        if (run.started_at.getTime() < Date.parse(sentAt)) {
          alarms.push(`attribution:run_predates_send:${run.id}`);
        }
      }
      for (const issue of attributionIssues) alarms.push(`attribution:${issue}`);
      const runs = attributedRows.map(enrichRun);
      const unattributedRuns = last.candidate_runs
        .filter((run) => !canonicalIds.has(run.id))
        .map(enrichRun);
      const paidRow =
        boundRows.find((row) => TERMINAL_PAID_STATES.has(row.state)) ??
        boundRows[0] ??
        last.paid.find((row) => row.unit === PAID_UNIT) ??
        last.paid[0];
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

      // Ledger-merged cumulative: the audit above already excludes window runs
      // the ledger counted (run_id dedupe — a run is never charged twice), so
      // here we only add THIS item's still-uncounted share. Historical reserve
      // keeps its own per-run bounds; new unknowns use the window reserve.
      const countedRuns = countedRunIds(ledger); // NormalizedLedger.counted
      const countedInReceipt = runs.filter((run) => countedRuns.has(run.id));
      const uncountedCostKnown =
        costKnownUsd - countedInReceipt.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0);
      const uncountedReserve =
        unknownCostRunIds.filter((id) => !countedRuns.has(id)).length *
        opts.thresholds.unknownReserveUsd;
      const cumulative = await auditWindowReceipts(
        opts.outDir,
        ledger,
        opts.thresholds.unknownReserveUsd,
      );
      const cumulativeKnown = cumulative.knownUsd + uncountedCostKnown;
      const cumulativeReserveUsd = cumulative.reserveUsd + uncountedReserve;

      const receipt: ItemReceipt = {
        group_id: item.id,
        batch: batchN,
        index: idx,
        started_at: sentAt,
        finished_at: new Date().toISOString(),
        scope: manifestScope,
        actor_ref: actorRef,
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
        cumulative_known_usd: cumulativeKnown,
        cumulative_reserve_usd: cumulativeReserveUsd,
        runs,
        unattributed_runs: unattributedRuns,
        jobs: last.jobs,
        subscription: last.subscription,
        attribution: {
          expected_revision_id: expected.revisionId,
          expected_admission_generation: expected.generation,
          expected_job_id: expectedJobId,
          bound_paid_rows: boundRows.map((row) => ({
            unit: row.unit,
            entity_revision: row.entity_revision,
            input_digest: row.input_digest,
            state: row.state,
          })),
          run_id_sources: runIdSources,
          issues: attributionIssues,
        },
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
          cumulativeReserveUsd,
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
    // Batch-close unknown-rate guardrail — same planned-batch denominator as
    // the per-enqueue gate; an all-skipped batch still adjudicates honestly.
    const batchTally = await countBatchReceipts(opts.outDir, items);
    if (
      stopped === undefined &&
      batchTally.unknown > items.length * opts.thresholds.maxUnknownRate
    ) {
      await writeStop(opts.outDir, 'unknown_rate', {
        batch: batchN,
        unknown: batchTally.unknown,
        denominator: `planned_batch_items=${items.length}`,
        rate: opts.thresholds.maxUnknownRate,
      });
      stopped = 'unknown_rate';
    }

    const batchReceipt = {
      batch: batchN,
      status: stopped === undefined ? 'passed' : 'stopped',
      stopped_by: stopped ?? null,
      scope: manifestScope,
      actor_ref: actorRef,
      processed: stats.items,
      counts: {
        sent_this_run: stats.items.filter((e) => !e.endsWith(':already-settled')).length,
        processed: batchTally.processed,
        unknown: batchTally.unknown,
        planned_batch_items: items.length,
        batch_known_usd: stats.knownUsd,
        batch_unknown_calls: stats.unknownCalls,
      },
      unknown_rate_rule: 'unknown > planned_batch_items * max_unknown_rate',
      invariant_violations: closeViolations,
      thresholds: opts.thresholds,
      cumulative: await auditWindowReceipts(opts.outDir, ledger, opts.thresholds.unknownReserveUsd),
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
  const { items: manifest } = parseManifest(await readJson(manifestPath));
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
    : command === 'drive' && flags.manifest && flags.out && flags.ledger
      ? drive({
          manifestPath: flags.manifest,
          outDir: flags.out,
          ledgerPath: flags.ledger,
          ...(flags.batch !== undefined ? { batch: Number(flags.batch) } : {}),
          thresholds: thresholdsFromFlags(flags),
          ...(flags['preflight-receipt'] !== undefined
            ? { preflightReceipt: flags['preflight-receipt'] }
            : {}),
          ...(flags.sent !== undefined ? { sentIdsPath: flags.sent } : {}),
        })
      : Promise.reject(
          new Error(
            'usage: check --manifest <m.json> <group_id> | drive --manifest <m.json> --out <dir> --preflight-receipt <r.json> --ledger <history-ledger.json> [--batch N] [--batch-size 20] [--per-question-usd 0.03] [--cumulative-usd 1] [--hard-cap-usd 3] [--unknown-reserve-usd 0.01] [--max-unknown-rate 0.1] [--sent ids.json]',
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
