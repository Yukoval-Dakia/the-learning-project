// YUK-697 — jyeoo_fetch handler: jyeoo-rs as a first-class DETERMINISTIC supply route.
//
// docs/design/2026-07-18-jyeoo-supply-selection-matching-design.md (whole);
// ~/jyeoo-rs/docs/DESIGN.md (producer contract).
//
// Unlike the SourcingTask handler (an LLM agent that self-reports provenance), this
// handler spawns a DETERMINISTIC scraper (jyeoo-rs), reads its NDJSON, validates each
// line against the SAME SourcedQuestion contract, and reuses the EXACT sourcing INSERT +
// source_verify chain. It is a confirmed forager instance (design §5): fetch → prefilter
// (exact + near dup, against active+draft pool) → draft pool → source_verify chain.
//
// Deterministic guarantees (design + producer contract):
//   - VIP hard-gate: a non-VIP / VIP-expired run produces hole-punched reference_md
//     (semantic-level corruption). The producer patch (docs/design/2026-07-19-yuk697-
//     producer-patch-proposal.md) makes jyeoo-rs exit 6 before emitting; belt-and-
//     suspenders, this handler ALSO fails the whole batch on any per-line vip:false.
//     Either way: NO INSERT before the batch is proven VIP-complete.
//   - Whole-batch discard on any non-zero exit / timeout / truncation (never ingest a
//     partial/mid-crash run).
//   - Dedup identity is CONTENT ONLY (canonical_content_hash + n-gram overlap) — never
//     ID/URL (detail IDs drift, design §5 / producer §9).
//   - Image-dependent questions are FILTERED pre-persist (the --images → R2 →
//     source_asset → question.figures glue is a declared follow-up; ingesting a figure
//     question with a rotting external URL corrupts judging — design §5.3).
//   - Every draft is INSERTed draft_status='draft' (audit:draft-status hard gate); the
//     chained source_verify promotes draft→active on pass.

import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Job, SendOptions } from 'pg-boss';

import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import { AgentRef } from '@/core/schema/business';
import type { DifficultyEvidenceT } from '@/core/schema/difficulty-evidence';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import {
  dispatchPendingVerifyIntents,
  writeVerifyDispatchIntent,
} from '@/server/boss/verify-dispatch-outbox';
import { writeEvent } from '@/server/events/queries';
import { SupplyTraceV1, type SupplyTraceV1T } from '@/server/question-supply/evidence-demand';
import {
  type JyeooFailureClass,
  classifyJyeooExit,
  isImageDependentQuestion,
  parseJyeooLine,
} from '@/server/question-supply/jyeoo-loom-adapter';
import { type SpawnJyeooFn, spawnJyeooFetch } from '@/server/question-supply/jyeoo-spawn';
import {
  JYEOO_DEFAULT_PAGES,
  JYEOO_FETCH_ROUTE,
  jyeooBinaryPath,
  jyeooDgTokenForBand,
  jyeooFetchEnabled,
  jyeooSpawnMaxStderrBytes,
  jyeooSpawnMaxStdoutBytes,
  jyeooSpawnTimeoutMs,
} from '@/server/question-supply/jyeoo-supply-config';
import type { DifficultyBand } from '@/server/question-supply/target-discovery';
import { insertSourcedDraft } from '@/server/questions/sourced-draft-insert';
import {
  canonicalQuestionContentHash,
  findExactQuestionDuplicate,
} from '@/server/quiz/content-fingerprint';
import { resolveSubjectProfile } from '@/subjects/profile';
import { kindsMatch } from '@/subjects/question-kind';
import { maxNgramOverlap } from './quiz_verify';
import { DEDUP_OVERLAP_THRESHOLD } from './source_verify';
import { matchesWhitelist } from './sourcing';

// Only 'knowledge' + 'manual' — jyeoo_fetch is auto-dispatched by the supply dispatcher
// with trigger 'knowledge' + an anchor knowledge_id. 'manual' mirrors sourcing (best-
// effort resolve; never skips on a free-form ref). No 'learning_item': jyeoo is target-
// driven off a single anchor KC (design §2.1), and the dispatcher only ever sends a KC.
// Deterministic scraper — NOT an LLM agent. `by: 'system'` is the honest provenance
// (aiAgentRef is for tasks with an LLM run + task_run_id; jyeoo_fetch has neither).
const JYEOO_CREATED_BY = AgentRef.parse({ by: 'system', task_kind: 'JyeooFetch' });

export const JYEOO_FETCH_TRIGGERS = ['knowledge', 'manual'] as const;
export type JyeooFetchTrigger = (typeof JYEOO_FETCH_TRIGGERS)[number];

export interface JyeooFetchJobData {
  trigger: JyeooFetchTrigger;
  ref_id: string;
  count?: number;
  knowledge_id?: string;
  kind?: string;
  difficulty_band?: DifficultyBand;
  supply_trace?: SupplyTraceV1T;
}

export const JYEOO_FETCH_DEFAULT_COUNT = 3;

// Pre-INSERT near-dup threshold. Reuses source_verify's DEDUP_OVERLAP_THRESHOLD (0.7)
// deliberately: the same n-gram overlap signal source_verify applies POST-insert against
// the ACTIVE pool, applied HERE pre-insert against the ACTIVE+DRAFT pool (design §5 —
// forager prefilter against active+draft so we never stack a duplicate DRAFT that
// source_verify's active-only dedup can't see).
export const JYEOO_NEAR_DUP_THRESHOLD = DEDUP_OVERLAP_THRESHOLD;

// Bound the per-anchor pool comparison — same LIMIT precedent as source_verify checkDedup.
const NEAR_DUP_POOL_LIMIT = 100;

export type EnqueueSourceVerifyFn = (questionIds: string[], options?: SendOptions) => Promise<void>;

async function defaultEnqueueSourceVerify(
  questionIds: string[],
  options?: SendOptions,
): Promise<void> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const boss = await getStartedBoss();
  await boss.send('source_verify', { question_ids: questionIds }, options);
}

export interface RunJyeooFetchParams {
  db: Db;
  trigger: JyeooFetchTrigger;
  refId: string;
  count?: number;
  knowledgeId?: string;
  kind?: string;
  difficultyBand?: DifficultyBand;
  supplyTrace?: SupplyTraceV1T;
  spawnJyeooFn?: SpawnJyeooFn;
  enqueueSourceVerify?: EnqueueSourceVerifyFn;
}

export type RunJyeooFetchStatus =
  | 'ready'
  | 'skipped:disabled'
  | 'skipped:ref_not_found'
  | 'skipped:subject_unsupported'
  | 'skipped:no_keyword'
  | `failed:${JyeooFailureClass}`;

export interface RunJyeooFetchResult {
  status: RunJyeooFetchStatus;
  question_ids?: string[];
  counts?: JyeooFetchCounts;
}

// Canary counts (P4). Every run emits these on its experimental:jyeoo_fetch event so the
// funnel (requested → fetched → validated → deduped → inserted → verify-enqueued) is
// observable; downstream verified/promoted are read from the chained source_verify
// events keyed by the same question_ids.
interface JyeooFetchCounts {
  requested: number; // desiredCount asked for.
  fetched: number; // non-blank NDJSON lines emitted.
  validated: number; // lines that passed the SourcedQuestion contract.
  invalid: number; // non-blank lines that failed JSON/Zod (dropped, batch still ok on exit 0).
  filtered_image: number; // valid questions dropped as image-dependent (pre-persist).
  filtered_kind: number; // valid questions dropped for not matching the pinned kind (pre-persist).
  deduped_exact: number; // dropped by canonical_content_hash exact match.
  deduped_near: number; // dropped by n-gram near-dup prefilter (active+draft pool).
  inserted: number; // drafts written (draft_status='draft').
  verify_enqueued: number; // drafts handed to the source_verify chain.
}

interface ResolvedJyeooTrigger {
  knowledgeNode: { id: string; name: string };
  /**
   * The EFFECTIVE subject domain (walks the parent chain for a child KC whose own
   * `domain` is null — the normal knowledge-tree shape). Used to resolve the subject
   * profile; a raw-row read would collapse child KCs onto `general` and falsely skip
   * jyeoo support (mirrors subjectIdForKnowledge / getEffectiveDomain canonical usage).
   */
  effectiveDomain: string | null;
}

/**
 * Resolve the anchor knowledge node. jyeoo is target-driven off ONE anchor KC (design
 * §2.1); an archived node is treated as missing (mirrors sourcing's guard — never mount
 * new material/FSRS onto a dead node). The explicit knowledge_id anchor (from the 找题
 * 次序) wins over the free-form refId, exactly like sourcing's F2 branch.
 */
async function resolveAnchor(
  db: Db,
  trigger: JyeooFetchTrigger,
  refId: string,
  knowledgeId?: string,
): Promise<ResolvedJyeooTrigger | null> {
  const lookupId = knowledgeId ?? (trigger === 'knowledge' || trigger === 'manual' ? refId : null);
  if (!lookupId) return null;
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
    .from(knowledge)
    .where(and(eq(knowledge.id, lookupId), isNull(knowledge.archived_at)))
    .limit(1);
  const k = rows[0];
  if (!k) return null;
  // Effective domain climbs the parent chain (child KCs carry domain=null). getEffectiveDomain
  // THROWS on a resolution failure (node missing / root-domain invariant) — fall back to the
  // raw row domain so an edge case degrades to general rather than crashing the job.
  let effectiveDomain: string | null = k.domain;
  try {
    effectiveDomain = await getEffectiveDomain(db, k.id);
  } catch (err) {
    console.warn('[jyeoo_fetch] effective-domain walk failed; using raw row domain:', err);
  }
  return { knowledgeNode: { id: k.id, name: k.name }, effectiveDomain };
}

/** Pull existing active+draft prompts sharing the anchor KC for the near-dup prefilter. */
async function fetchNearDupPool(
  db: Db,
  anchorKid: string,
): Promise<Array<{ id: string; prompt_md: string }>> {
  return (
    db
      .select({ id: question.id, prompt_md: question.prompt_md })
      .from(question)
      // Include DRAFTS (no notDraftPredicate): the forager prefilter must catch a
      // duplicate we (or a prior run) already staged as a draft, which source_verify's
      // active-only dedup would miss (design §5).
      .where(sql`${question.knowledge_ids} @> ${JSON.stringify([anchorKid])}::jsonb`)
      // Newest-first so a bounded LIMIT samples the most recently written rows (the most
      // likely near-dup comparison set) deterministically — a LIMIT with no ORDER BY is an
      // arbitrary sample that could miss a near-duplicate when a KC has >LIMIT questions.
      .orderBy(desc(question.created_at))
      .limit(NEAR_DUP_POOL_LIMIT)
  );
}

const emptyCounts = (requested: number): JyeooFetchCounts => ({
  requested,
  fetched: 0,
  validated: 0,
  invalid: 0,
  filtered_image: 0,
  filtered_kind: 0,
  deduped_exact: 0,
  deduped_near: 0,
  inserted: 0,
  verify_enqueued: 0,
});

export async function runJyeooFetch(params: RunJyeooFetchParams): Promise<RunJyeooFetchResult> {
  const { db, trigger, refId } = params;
  const count = params.count ?? JYEOO_FETCH_DEFAULT_COUNT;
  const spawnJyeoo = params.spawnJyeooFn ?? spawnJyeooFetch;
  const enqueueSourceVerify = params.enqueueSourceVerify ?? defaultEnqueueSourceVerify;

  // Kill-switch defense (P4). The dispatcher already skips jyeoo_fetch when disabled;
  // this guards a job that reached the queue before the flag flipped.
  if (!jyeooFetchEnabled()) return { status: 'skipped:disabled' };

  const resolved = await resolveAnchor(db, trigger, refId, params.knowledgeId);
  if (!resolved) return { status: 'skipped:ref_not_found' };

  const subjectProfile = resolveSubjectProfile(resolved.effectiveDomain);
  const jyeooSubject = subjectProfile.jyeooSupply?.subject ?? null;
  if (!jyeooSubject) return { status: 'skipped:subject_unsupported' };

  const keyword = resolved.knowledgeNode.name?.trim();
  if (!keyword) return { status: 'skipped:no_keyword' };

  const anchorKid = resolved.knowledgeNode.id;
  const whitelist = (subjectProfile.sourceWhitelist ?? []) as string[];
  const dg = jyeooDgTokenForBand(params.difficultyBand ?? 'near');
  const triggerEventId = `jyeoo_fetch_trigger_${createId()}`;
  const counts = emptyCounts(count);

  const args = [
    'search',
    keyword,
    '--subject',
    jyeooSubject,
    '--pages',
    String(JYEOO_DEFAULT_PAGES),
    '--dg',
    dg,
    '--emit',
    'loom',
  ];

  let failureStage: 'producer' | 'persist' | 'event' | 'dispatch' = 'producer';
  try {
    // ── spawn the deterministic producer (bounded stdout/stderr + timeout) ──────
    let spawnResult: Awaited<ReturnType<SpawnJyeooFn>>;
    try {
      spawnResult = await spawnJyeoo({
        binaryPath: jyeooBinaryPath(),
        args,
        timeoutMs: jyeooSpawnTimeoutMs(),
        maxStdoutBytes: jyeooSpawnMaxStdoutBytes(),
        maxStderrBytes: jyeooSpawnMaxStderrBytes(),
      });
    } catch (spawnErr) {
      // OS-level spawn failure (ENOENT etc.) — terminal 'spawn' class, no INSERT.
      return finishFailure({
        db,
        triggerEventId,
        params,
        counts,
        failureClass: 'spawn',
        detail: `spawn failed: ${(spawnErr as Error).message}`,
        retryable: false,
      });
    }

    // ── classify exit: any non-zero / timeout / truncation ⇒ discard whole batch ─
    const classification = classifyJyeooExit(spawnResult);
    const truncated = spawnResult.stdoutTruncated;
    if (classification.failure !== null || truncated) {
      const failureClass: JyeooFailureClass = classification.failure ?? 'unknown';
      const retryable = classification.failure !== null ? classification.retryable : false;
      return finishFailure({
        db,
        triggerEventId,
        params,
        counts,
        failureClass,
        detail: truncated
          ? `stdout exceeded ${jyeooSpawnMaxStdoutBytes()} bytes; batch discarded (possible mid-stream truncation)`
          : `jyeoo-rs exit ${spawnResult.exitCode}${spawnResult.signal ? ` signal ${spawnResult.signal}` : ''}: ${stderrTail(spawnResult.stderr)}`,
        retryable,
      });
    }

    // ── parse NDJSON lines ─────────────────────────────────────────────────────
    const validQuestions: SourcedQuestionT[] = [];
    let vipViolation = false;
    for (const line of spawnResult.lines) {
      const parsed = parseJyeooLine(line);
      if (!parsed.ok) {
        // A blank line is a skip (trailing newline); a non-blank invalid line counts as
        // both fetched and invalid but is dropped (one bad line must not sink the batch).
        if (parsed.reason !== 'blank') {
          counts.invalid += 1;
          counts.fetched += 1;
        }
        continue;
      }
      counts.fetched += 1;
      counts.validated += 1;
      // VIP belt (design §5): a per-line vip:false means the producer served a hole-
      // punched detail template. Fail the WHOLE batch before any INSERT.
      if (parsed.jyeoo.vip === false) vipViolation = true;
      validQuestions.push(parsed.question);
    }

    if (vipViolation) {
      return finishFailure({
        db,
        triggerEventId,
        params,
        counts,
        failureClass: 'vip',
        detail:
          'producer emitted a non-VIP (vip:false) line; whole batch discarded (VIP expiry ⇒ hole-punched reference_md must not be ingested)',
        retryable: false,
      });
    }

    // ── pre-persist filters: image-dependent + pinned-kind mismatch ─────────────
    // The dispatcher may pin a kind (diagnostic / format-diversity / calibration targets,
    // e.g. `choice`). The producer only INFERS kind, so — mirroring the sourcing path's
    // params.kind enforcement — drop any question whose kind does not match the pin BEFORE
    // INSERT (kindsMatch normalizes both to canonical, so `single_choice` matches `choice`).
    // Otherwise a wrong-kind draft would pass source_verify while leaving the gap unfilled.
    const textQuestions: SourcedQuestionT[] = [];
    for (const q of validQuestions) {
      if (isImageDependentQuestion(q)) {
        counts.filtered_image += 1;
        continue;
      }
      if (params.kind && !kindsMatch(q.kind, params.kind)) {
        counts.filtered_kind += 1;
        continue;
      }
      textQuestions.push(q);
    }

    // ── near-dup prefilter (active+draft pool + in-batch) ──────────────────────
    const now = new Date();
    const poolPrompts = (await fetchNearDupPool(db, anchorKid)).map((r) => r.prompt_md);
    const batchPrompts: string[] = [];
    const questionIds: string[] = [];
    const difficultyEvidenceByQuestion: Array<{
      question_id: string;
      evidence: DifficultyEvidenceT;
    }> = [];

    failureStage = 'persist';
    await db.transaction(async (tx) => {
      for (const q of textQuestions) {
        if (questionIds.length >= count) break; // respect desiredCount — don't over-supply.

        // Near-dup (content n-gram) against active+draft pool + already-staged batch.
        const nearOverlap = maxNgramOverlap(q.prompt_md, [...poolPrompts, ...batchPrompts]);
        if (nearOverlap >= JYEOO_NEAR_DUP_THRESHOLD) {
          counts.deduped_near += 1;
          continue;
        }

        // Exact-dup (canonical content hash) — content fingerprint, never ID/URL.
        const canonicalContentHash = canonicalQuestionContentHash({
          promptMd: q.prompt_md,
          referenceMd: q.reference_md,
          choicesMd: q.choices_md,
          rubricJson: q.rubric_json,
        });
        const existingDuplicate = await findExactQuestionDuplicate(tx, canonicalContentHash);
        if (existingDuplicate) {
          counts.deduped_exact += 1;
          continue;
        }

        const id = createId();
        // jyeoo emits knowledge_ids=[] (producer non-goal), so the anchor KC is the
        // attribution (design §2.1). fetched_at = run time (SourcedQuestion has none).
        const inserted = await insertSourcedDraft(tx, {
          id,
          q,
          knowledgeIds: [anchorKid],
          sourceRoute: JYEOO_FETCH_ROUTE,
          createdBy: JYEOO_CREATED_BY,
          whitelistMatch: matchesWhitelist(q.source_url, whitelist),
          fetchedAt: now.toISOString(),
          canonicalContentHash,
          supplyTrace: params.supplyTrace,
          now,
        });
        if (inserted.status === 'raced_duplicate') {
          counts.deduped_exact += 1;
          continue;
        }
        await writeVerifyDispatchIntent(tx, {
          questionId: id,
          verifier: 'source_verify',
          supplyTrace: inserted.supplyTrace,
          createdAt: now,
        });
        questionIds.push(id);
        batchPrompts.push(q.prompt_md);
        difficultyEvidenceByQuestion.push({
          question_id: id,
          evidence: inserted.difficultyEvidence,
        });
      }
    });
    counts.inserted = questionIds.length;

    // ── chain source_verify FIRST (best-effort; drafts + intents are durable) ────
    // Dispatch BEFORE the canary event so counts.verify_enqueued reflects the real number
    // of drafts handed to the chain — writing the event first would freeze verify_enqueued
    // at 0 and make the funnel metric permanently wrong.
    if (questionIds.length > 0) {
      failureStage = 'dispatch';
      const dispatchResult = await dispatchPendingVerifyIntents(db, {
        questionIds,
        enqueue: async (verifier, ids, options) => {
          if (verifier !== 'source_verify') {
            throw new Error(`jyeoo_fetch outbox received unexpected verifier '${verifier}'`);
          }
          await enqueueSourceVerify(ids, options);
        },
      });
      counts.verify_enqueued = questionIds.length - dispatchResult.failed;
      if (dispatchResult.failed > 0) {
        console.error(
          '[jyeoo_fetch] source_verify enqueue failed; durable intents left for recovery:',
          questionIds,
        );
      }
    }

    // ── canary success event (AFTER dispatch so counts.verify_enqueued is accurate) ─
    failureStage = 'event';
    await writeEvent(db, {
      id: createId(),
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'jyeoo_fetch',
      action: 'experimental:jyeoo_fetch',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'success',
      payload: {
        trigger,
        ref_id: refId,
        knowledge_id: anchorKid,
        jyeoo_subject: jyeooSubject,
        dg,
        question_ids: questionIds,
        counts,
        difficulty_evidence: difficultyEvidenceByQuestion,
        ...(params.supplyTrace ? { supply_trace: params.supplyTrace } : {}),
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    return { status: 'ready', question_ids: questionIds, counts };
  } catch (err) {
    // Unexpected (persist/event/dispatch) failure — write a failure event + re-throw so
    // pg-boss retries (transient DB errors). Producer-classified failures never reach
    // here (they return via finishFailure above).
    try {
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'jyeoo_fetch',
        action: 'experimental:jyeoo_fetch',
        subject_kind: 'query',
        subject_id: triggerEventId,
        outcome: 'failure',
        payload: {
          trigger,
          ref_id: refId,
          error: String((err as Error).message ?? err),
          failure_stage: failureStage,
          counts,
          ...(params.supplyTrace ? { supply_trace: params.supplyTrace } : {}),
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(),
      });
    } catch (cleanupErr) {
      console.error('[jyeoo_fetch] catch-block cleanup failed for', refId, cleanupErr);
    }
    throw err;
  }
}

/** Truncate a stderr tail for the failure event (bounded — the full stderr is already capped). */
function stderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= 500) return trimmed;
  return `…${trimmed.slice(-500)}`;
}

interface FinishFailureArgs {
  db: Db;
  triggerEventId: string;
  params: RunJyeooFetchParams;
  counts: JyeooFetchCounts;
  failureClass: JyeooFailureClass;
  detail: string;
  retryable: boolean;
}

/**
 * Record a producer-classified failure (NO INSERT happened) + either return a terminal
 * failed status or throw for retry. Terminal classes (auth/vip/args/parse/spawn/unknown)
 * return — retrying won't help until a human/producer fixes the cookie/VIP/binary.
 * Retryable classes (network/timeout) throw so pg-boss redelivers.
 */
async function finishFailure(args: FinishFailureArgs): Promise<RunJyeooFetchResult> {
  const { db, triggerEventId, params, counts, failureClass, detail, retryable } = args;
  await writeEvent(db, {
    id: createId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'jyeoo_fetch',
    action: 'experimental:jyeoo_fetch',
    subject_kind: 'query',
    subject_id: triggerEventId,
    outcome: 'failure',
    payload: {
      trigger: params.trigger,
      ref_id: params.refId,
      failure_class: failureClass,
      failure_detail: detail,
      counts,
      ...(params.supplyTrace ? { supply_trace: params.supplyTrace } : {}),
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
  if (retryable) {
    throw new Error(`jyeoo_fetch producer failure (${failureClass}, retryable): ${detail}`);
  }
  return { status: `failed:${failureClass}`, counts };
}

export function buildJyeooFetchHandler(
  db: Db,
  deps: { spawnJyeooFn?: SpawnJyeooFn; enqueueSourceVerify?: EnqueueSourceVerifyFn } = {},
): (jobs: Job<JyeooFetchJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const data = job.data;
      if (!data?.trigger || !data?.ref_id) {
        console.warn('[jyeoo_fetch] job missing trigger/ref_id', job.id);
        continue;
      }
      // supply_trace is best-effort provenance — parse at the trust boundary with
      // safeParse so a malformed payload drops the trace instead of throwing before the
      // handler's failure-bottom can emit a structured event.
      let supplyTrace: SupplyTraceV1T | undefined;
      if (data.supply_trace) {
        const parsed = SupplyTraceV1.safeParse(data.supply_trace);
        if (parsed.success) supplyTrace = parsed.data;
        else console.warn('[jyeoo_fetch] ignoring malformed supply_trace in job data', job.id);
      }
      const result = await runJyeooFetch({
        db,
        trigger: data.trigger,
        refId: data.ref_id,
        count: data.count,
        ...(data.knowledge_id ? { knowledgeId: data.knowledge_id } : {}),
        ...(data.kind ? { kind: data.kind } : {}),
        ...(data.difficulty_band ? { difficultyBand: data.difficulty_band } : {}),
        ...(supplyTrace ? { supplyTrace } : {}),
        spawnJyeooFn: deps.spawnJyeooFn,
        enqueueSourceVerify: deps.enqueueSourceVerify,
      });
      console.log(`[jyeoo_fetch] ${data.trigger}:${data.ref_id} -> ${result.status}`);
    }
  };
}
