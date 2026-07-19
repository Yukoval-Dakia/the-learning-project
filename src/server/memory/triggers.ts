import { eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Job, PgBoss } from 'pg-boss';

import { PermanentError, RetryableError } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { writeCostLedger } from '@/server/ai/log';
import { glmChatCostCny } from '@/server/ai/pricing';
import { BRIEF_REFRESH_BUDGET } from '@/server/ai/tools/budgets';
import { fromPgBossDrizzleTx } from '@/server/boss/pg-boss-drizzle';
import {
  EXPIRE_LLM,
  FAST_QUEUE_OPTS,
  createJobQueue,
  createOrUpdateQueue,
} from '@/server/boss/queue-config';
import {
  QUALIFYING_ACTIONS,
  listActiveSubjectsSinceRefresh,
  loadSubjectBriefEvents,
  resolveQualifyingEventSubjects,
  selectSubjectsForRun,
  subjectScopeHasNewEvidence,
} from './active-subjects';
import {
  type GenerateBrief,
  listStaleBriefScopes,
  regenerateMemoryBrief,
  scopeHasNewEvidence,
} from './brief';
import { type MemoryClient, type MemoryEventInput, createMemoryClient } from './client';
import {
  type CandidateEntry,
  type NewMemoryEntry,
  type ReconcileAction,
  ReconcileParseError,
  isHardDelete,
  judgeReconciliation,
  kindForbidsMerge,
  needsOldTarget,
  passesStructuralCorroboration,
} from './reconcile-llm';
import {
  type PlannedRow,
  insertPlannedRows,
  loadUnappliedLog,
  makePlannedRow,
  markApplied,
} from './reconcile-store';
import { searchMemories } from './search-memories';

// P5.2 (YUK-143) — per-subject brief refresh lookback for the nightly sweep +
// regen handler. Bounded initial-build window for never-built subjects (BR-5).
const BRIEF_REFRESH_LOOKBACK_DAYS = 30;
const SUBJECT_SCOPE_PREFIX = 'subject:';

export const MEMORY_EVENT_INGEST_QUEUE = 'memory_event_ingest';
export const MEMORY_BRIEF_REGEN_QUEUE = 'memory_brief_regen';
export const MEMORY_BRIEF_SWEEP_QUEUE = 'memory_brief_sweep';
// ADR-0021 outbox queues. Poller fires every minute (pg-boss cron minimum);
// recovery sweep hourly is unbounded and catches anything the poller missed
// (e.g., worker restart, single fast-burst > batch size).
export const MEMORY_INGEST_OUTBOX_POLL_QUEUE = 'memory_ingest_outbox_poll';
export const MEMORY_INGEST_OUTBOX_RECOVER_QUEUE = 'memory_ingest_outbox_recover';
// P2 (YUK-342): reconcile queue — event-driven (no cron schedule). Enqueued
// after every addEventMemory fan-out. singletonKey serializes per-user.
export const MEMORY_RECONCILE_QUEUE = 'memory_reconcile';
const OUTBOX_POLL_BATCH = 50;
const REGEN_SINGLETON_SECONDS = 6 * 60;
// Reconcile singleton window — short (reconcile is time-sensitive convergence,
// unlike the 6-min brief). Owner directive: 90s.
const RECONCILE_SINGLETON_SECONDS = 90;
// Reconcile search topK — owner directive: 30.
const RECONCILE_TOP_K = 30;

type BossLike = Pick<PgBoss, 'createQueue' | 'updateQueue'> & {
  work(name: string, ...args: unknown[]): Promise<unknown>;
  schedule(name: string, cron: string, data: object, options: object): Promise<unknown>;
  send(name: string, data: object, options?: object): Promise<string | null>;
};

/**
 * P2 (YUK-342): Deterministic (non-LLM) mapping of event.action → memory kind.
 * Fed into mem0 metadata as payload top-level `kind`, consumed by the reconcile
 * LLM per-kind rules.
 *
 * Confirmed action mappings (from src/core/schema/event/known.ts):
 *   - attempt (AttemptOnQuestion)       → event  (episodic attempt fact)
 *   - review (ReviewOnQuestion)          → event  (episodic review fact)
 *   - judge (JudgeOnEvent)               → weakness (identifies mistake cause)
 *   - propose (ProposeKnowledge/Edge)    → weakness (knowledge gap signal)
 *   - rate (RateEvent/RateKnowledgeEdge) → preference (user accept/dismiss)
 *   - suppress (SuppressArtifactLink)    → preference (user hides link)
 *   - accept_suggestion (AcceptSuggestionChip) → preference (user preference)
 *   - correct (CorrectEvent/Artifact)    → event  (correction is episodic)
 *   - generate (GenerateArtifact/Edge)   → event  (AI output is episodic)
 *   - extract (ExtractSourceDocument)    → event  (OCR extraction is episodic)
 *   - tool_use (ToolUseQuery)            → event  (agent tool call is episodic)
 *
 * Experimental actions (src/core/schema/event/experimental.ts):
 *   - experimental:user_cause → weakness (user fills mistake cause)
 *   - other experimental:*    → event (conservative default)
 *
 * Fallback: any unmapped action → event (conservative, leans KEEP_BOTH).
 *
 * NOTE: `habit` is a valid kind in the reconcile prompt (paired with preference
 * for the single-latest-truth rule) but is NOT currently produced by this
 * deterministic mapper — reserved for a future recurring-behavior signal. Until
 * then preference covers its rule, so the absence is harmless.
 */
export function mapEventActionToKind(action: string): string {
  switch (action) {
    case 'judge':
    case 'propose':
    case 'experimental:user_cause':
      return 'weakness';
    case 'rate':
    case 'suppress':
    case 'accept_suggestion':
      return 'preference';
    case 'attempt':
    case 'review':
    case 'correct':
    case 'generate':
    case 'extract':
    case 'tool_use':
      return 'event';
    default:
      // experimental:* (non-reserved) and any future action → event (conservative)
      return 'event';
  }
}

async function defaultLoadEvent(db: Db, eventId: string): Promise<MemoryEventInput | null> {
  const rows = await db.select().from(event).where(eq(event.id, eventId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    // P3 (YUK-351): thread actor_kind for the extraction gate (below).
    actor_kind: row.actor_kind,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    payload: row.payload,
    affected_scopes: row.affected_scopes,
    created_at: row.created_at,
    kind: mapEventActionToKind(row.action),
  };
}

/**
 * P3 (YUK-351) extraction gate — the write-side invariant for mem0.
 *
 * ADR-0039 §决定 7 invariant (i) + Phase 2 synthesis §6.3 C3 / §7 H6 (owner-locked
 * 2026-06-15): **only user-originated events may feed mem0 extraction; the
 * orchestrator's own output must NEVER enter the extraction source.** This closes
 * the confirmation loop the design flags as a HIGH-severity break of the
 * anti-injection 五防 (project memory `feedback_no_recursive_prompt_injection`):
 *
 *   agent output → event(actor_kind='agent') → mem0 infer:true extracts a
 *   semantic-trait about "the user" → searchMemories feeds it back into the next
 *   orchestration prompt → the model self-confirms its own prior output as a fact.
 *
 * The gate sits at the single write-side seam (buildMemoryEventIngestHandler),
 * BEFORE addEventMemory's extraction LLM call. It is a pure deterministic function
 * over event.actor_kind (NOT NULL, 'user' | 'agent' — src/db/schema.ts +
 * core/schema/event/known.ts), kept exported + unit-tested per the ADR's "写成
 * extraction gate invariant + 单测" directive.
 *
 * Fail-closed: anything that is not exactly 'user' is rejected (defensive against
 * a future actor_kind value or a malformed row — never silently widen the feed).
 *
 * NOTE — narrowing scope (design §3.7 "喂信号收窄"): the deeper B4 semantic-trait
 * accept gate (a PG pending table + reject/edit face, §7.2 owner pick "落 PG") and
 * "数值留结构表" feed-narrowing are SEPARATE, larger increments (new schema + ADR +
 * UI). This gate implements the load-bearing, owner-locked, code-side C3/H6
 * invariant that the design names as the blocker; the accept-gate UI/table is
 * tracked as a follow-up.
 */
export function shouldExtractToMemory(event: Pick<MemoryEventInput, 'actor_kind'>): boolean {
  return event.actor_kind === 'user';
}

// ADR-0021 — outbox poll handler is the sole producer. Dedup is enforced by
// the `ingest_at IS NULL` partition (a row is enqueued exactly once and the
// stamp commits in the same tx as the enqueue). singletonKey + the iter2
// band-aids it required (writeEvent inline retry collapse, tx-rollback orphan
// slot) are gone.
export async function enqueueEventMemoryIngest(
  boss: Pick<BossLike, 'send'>,
  eventId: string,
  options?: object,
) {
  await boss.send(MEMORY_EVENT_INGEST_QUEUE, { event_id: eventId }, options);
}

export async function enqueueBriefRegen(
  boss: Pick<BossLike, 'send'>,
  scopeKey: string,
  // P5.2 (PR #218 fix) — optional stable sweep timestamp (ISO). The subject
  // regen path floors its event reload at `now - lookbackDays` for a never-built
  // subject; threading the SWEEP's `now` (rather than letting regen re-read the
  // clock at job-run time) closes the race where an event near the 30d lookback
  // edge is detected at sweep time T but ages out by regen time T+δ. Global jobs
  // pass no `now` (global path is clock-independent / unchanged).
  now?: Date,
) {
  await boss.send(
    MEMORY_BRIEF_REGEN_QUEUE,
    now ? { scope_key: scopeKey, now: now.toISOString() } : { scope_key: scopeKey },
    {
      // singletonKey unchanged — per-scope dedup must still collapse the stale
      // loop's enqueue (if any) and the per-subject enqueue into one job.
      singletonKey: `memory.regen.${scopeKey}`,
      singletonSeconds: REGEN_SINGLETON_SECONDS,
      singletonNextSlot: true,
    },
  );
}

// P2 (YUK-342): the reconcile job payload threads the EXTRACTED memory text +
// created_ms alongside the id. Searching mem0 by an opaque UUID embeds the UUID
// string (semantic noise) and rarely retrieves the memory itself — so the text
// (from add()'s results[].memory) must travel with the id, not be re-derived.
export type ReconcileMemInput = { id: string; text: string; created_ms: number; kind: string };

export async function enqueueMemoryReconcile(
  boss: Pick<BossLike, 'send'>,
  memories: ReconcileMemInput[],
  userId: string,
): Promise<void> {
  if (memories.length === 0) return;
  await boss.send(
    MEMORY_RECONCILE_QUEUE,
    { memories, user_id: userId },
    {
      singletonKey: `memory.reconcile.${userId}`,
      singletonSeconds: RECONCILE_SINGLETON_SECONDS,
      singletonNextSlot: true,
      // Retry on transient failure (the handler rethrows RetryableError; planned
      // rows replay idempotently). Without this, a rethrown RetryableError would
      // dead-letter on the first try and the batch would never reconcile.
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
    },
  );
}

export function buildMemoryEventIngestHandler(
  db: Db,
  boss: Pick<BossLike, 'send'>,
  deps: {
    loadEvent?: (db: Db, eventId: string) => Promise<MemoryEventInput | null>;
    memoryClient?: MemoryClient;
  } = {},
): (jobs: Job<{ event_id: string }>[]) => Promise<void> {
  const loadEvent = deps.loadEvent ?? defaultLoadEvent;
  let memoryClient = deps.memoryClient;
  return async (jobs) => {
    memoryClient ??= createMemoryClient();
    const client = memoryClient;
    for (const job of jobs) {
      const row = await loadEvent(db, job.data.event_id);
      if (!row) continue;

      // P3 (YUK-351) extraction gate (ADR-0039 §决定 7 (i) / Phase 2 §6.3 C3 / §7 H6):
      // agent-originated events must NEVER feed mem0 extraction (closes the
      // confirmation loop). The brief NOTE layer is orthogonal — it reads events
      // straight from PG (brief.ts:loadEventsFromDb) and legitimately summarizes
      // agent activity too — so the brief regen fan-out STILL runs for gated events;
      // only addEventMemory + reconcile are skipped.
      const admitToExtraction = shouldExtractToMemory(row);

      // P2 (YUK-342): capture add() return — results[].id + results[].memory are
      // the extracted memory rows (mem0 infer:true). Fan-out brief regen, then
      // enqueue reconcile for the new memory ids.
      const memResult = admitToExtraction ? await client.addEventMemory(row) : null;
      for (const scopeKey of row.affected_scopes) {
        await enqueueBriefRegen(boss, scopeKey);
      }

      // YUK-581 — subject brief bridge. The core learning events never tag a
      // `subject:*` scope in affected_scopes (attempt/review carry only
      // referenced_knowledge_ids; record_capture resolves its subject from the
      // linked learning_record — active-subjects.ts §1.2 / BR-10), so the
      // affected_scopes fan-out above can NEVER refresh the per-subject brief.
      // Resolve the qualifying event → subject via the SAME canonical resolver the
      // nightly sweep uses and enqueue its `subject:<id>` regen, moving subject-
      // brief freshness from the next-day 03:00 sweep to ≤6min after the activity.
      // enqueueBriefRegen already dedups per scope_key on a 6-min singleton, so a
      // burst of same-subject activity collapses to one regen (no extra guard). The
      // resolver produces a canonical subject-profile id, never a slugged payload
      // value, so it can never collide with an affected_scopes tag → no double-invoke
      // guard needed. Best-effort: a resolve/enqueue failure is swallowed + warned so
      // the ingest job never retries on a bridge failure — a dropped bridge is exactly
      // what the 03:00 cron sweep now backstops (its role narrows to cold-start / DLQ /
      // dropped-delivery / dormant coverage). Runs BEFORE the extraction gate `continue`
      // so it fires for every qualifying event, mirroring the brief-note fan-out above.
      if ((QUALIFYING_ACTIONS as readonly string[]).includes(row.action)) {
        try {
          const subjectByEventId = await resolveQualifyingEventSubjects(db, [
            {
              id: row.id,
              action: row.action,
              subject_kind: row.subject_kind,
              subject_id: row.subject_id,
              outcome: null,
              payload: row.payload,
              created_at: row.created_at,
            },
          ]);
          const subjectId = subjectByEventId.get(row.id);
          if (subjectId) {
            await enqueueBriefRegen(boss, `${SUBJECT_SCOPE_PREFIX}${subjectId}`);
          }
        } catch (err) {
          console.warn(
            `[memory_brief_bridge] subject bridge failed for event ${row.id}; nightly sweep will backstop`,
            err,
          );
        }
      }

      if (!admitToExtraction) continue;
      // Thread the extracted memory text + created_ms (the event's time) so the
      // reconcile job searches by text, not by an opaque UUID (see ReconcileMemInput).
      const createdMs = row.created_at.getTime();
      const newMemories: ReconcileMemInput[] = (memResult?.results ?? [])
        .filter(
          (m): m is { id: string; memory: string } => typeof m.id === 'string' && m.id.length > 0,
        )
        .map((m) => ({
          id: m.id,
          text: typeof m.memory === 'string' ? m.memory : '',
          created_ms: createdMs,
          kind: row.kind,
        }));
      if (newMemories.length > 0) {
        await enqueueMemoryReconcile(boss, newMemories, 'self');
      }
    }
  };
}

export function buildMemoryBriefRegenHandler(
  db: Db,
  deps: {
    memoryClient?: Pick<MemoryClient, 'search'>;
    generateBrief: GenerateBrief;
  },
): (jobs: Job<{ scope_key: string; now?: string }>[]) => Promise<void> {
  // F-4 (PR #232 review) — keep the injected test client here, but DO NOT init
  // the real Mem0 client at the top of the batch. `createMemoryClient()` throws
  // when its env (ZHIPU_API_KEY / DASHSCOPE_API_KEY / DATABASE_URL for Mem0) is
  // missing; doing it before the per-scope try would reject the WHOLE pg-boss
  // job → nightly retry storm → the F-1 per-scope catch is defeated. Mem0
  // fact-search is SUPPLEMENTARY — brief regen must still run from events when
  // Mem0 is unavailable. The lazy `??= createMemoryClient()` now lives inside
  // searchFacts' own try (below) so a missing-Mem0-key degrades to facts=[].
  let memoryClient = deps.memoryClient;
  return async (jobs) => {
    for (const job of jobs) {
      const scopeKey = job.data.scope_key;
      // F-1 (YUK-185, D8): one scope's LLM/provider throw (e.g. resolveTaskProvider
      // throwing on a missing XIAOMI_API_KEY, providers.ts:88, or any runTask failure
      // inside the injected generateBrief) must NOT reject the pg-boss job and trigger
      // a nightly retry storm. The writer/generator stays LOUD (re-throws, never
      // persists a blank row); the graceful "log + leave old brief intact" posture
      // lives HERE. Catch per scope, log, continue — the prior brief row is never
      // overwritten because the upsert in regenerateMemoryBrief is only reached on
      // success. Mirrors knowledge_propose_nightly.ts:96-99 (per-job try/catch).
      try {
        const searchFacts = async () => {
          // F-4 (PR #232 review) — self-degrading. Lazily init the Mem0 client
          // HERE so a missing-key throw stays contained: missing Mem0 env →
          // facts=[] (brief still generates from events). A missing LLM key
          // instead throws later inside generateBrief, caught by the F-1
          // per-scope catch → logged skip. Neither path storms the job.
          try {
            memoryClient ??= createMemoryClient();
            // P3 (YUK-351): read through the searchMemories wrapper so the brief
            // never fixes already-superseded facts into its long-term summary
            // (brief.ts:195 design note). Filters soft-superseded + recency-reranks.
            const result = await searchMemories(memoryClient, `memory brief ${scopeKey}`, {
              topK: 10,
              filters: { scope_key: scopeKey },
            });
            return (result?.results ?? []).map((item) => ({ id: item.id, memory: item.memory }));
          } catch (err) {
            console.warn(
              `[memory_brief_regen] Mem0 fact search unavailable for ${scopeKey}; proceeding without facts`,
              err,
            );
            return [];
          }
        };

        // BR-10 (load-bearing) — branch by scope prefix. attempt/review events
        // never tag `subject:` in affected_scopes (§1.2), so the global path's
        // affected_scopes-based guard + loader return false / ~0 rows for an
        // active subject. The subject path instead reads a knowledge-resolved
        // event window (the SAME resolution as the activity-detection sweep) and
        // gates on a KNOWLEDGE-resolved freshness check — never the affected_scopes
        // one. The active-subject sweep already filtered to fresh subjects, and
        // (since PR #218 FIX 1) listStaleBriefScopes excludes `subject:*`, so the
        // stale loop no longer enqueues dormant subjects. The guard is retained as
        // defense-in-depth: a pg-boss singleton re-fire within the dedup window, or
        // a refreshed_at-vs-latest_evidence_at skew, could still hand this branch a
        // subject with no genuinely new evidence; the guard makes that a clean skip
        // (BR-2: no LLM call, no refreshed_at bump for a dormant subject).
        if (scopeKey.startsWith(SUBJECT_SCOPE_PREFIX)) {
          const subjectId = scopeKey.slice(SUBJECT_SCOPE_PREFIX.length);
          // P5.2 (PR #218 fix) — reuse the SWEEP's `now` (threaded via the job
          // payload) rather than re-reading the clock here. For a never-built
          // subject the floor is `now - lookbackDays`; if regen recomputed it with a
          // fresh clock at job-run time (T+δ), an event the sweep detected near the
          // 30d edge could age out → empty window → silent miss. Sharing the sweep's
          // `now` keeps detection and reload on the SAME floor. Falls back to a fresh
          // clock only if the job carries no `now` (e.g., a job from before this fix).
          const now = job.data.now ? new Date(job.data.now) : new Date();
          // loadSubjectBriefEvents floors at THIS subject's own brief refreshed_at
          // (lookbackDays only as the never-built fallback), the SAME
          // subjectEventFloor predicate the detection sweep uses — so any subject
          // the sweep flagged active reloads ≥1 event here and is never silently
          // starved by a flat now-30d floor.
          const events = await loadSubjectBriefEvents(db, subjectId, {
            lookbackDays: BRIEF_REFRESH_LOOKBACK_DAYS,
            now,
          });
          if (!(await subjectScopeHasNewEvidence(db, scopeKey, events))) continue;
          await regenerateMemoryBrief({
            db,
            scopeKey,
            loadEvents: async () => events,
            searchFacts,
            generate: deps.generateBrief,
          });
          continue;
        }

        // BR-6 — global (and any legacy affected_scopes-tagged scope): unchanged.
        // Still gated by scopeHasNewEvidence + loaded via loadEventsFromDb.
        if (!(await scopeHasNewEvidence(db, scopeKey))) continue;
        await regenerateMemoryBrief({
          db,
          scopeKey,
          searchFacts,
          generate: deps.generateBrief,
        });
      } catch (err) {
        // Leave the prior brief row intact (the upsert is only reached on success)
        // and move to the next scope — no rethrow, no pg-boss reject/retry storm.
        console.error(`[memory_brief_regen] scope ${scopeKey} failed; leaving prior brief`, err);
      }
    }
  };
}

/**
 * YUK-557 (Q1) — max candidate score for the RETRACT_NEW null-old_index fallback.
 * outlier-permissive approximation: `max` is the statistic MOST sensitive to a
 * single entity-boosted candidate spiking to ~0.99, so it biases toward PASSING
 * the floor. Acceptable because the null-old_index path is the noise∪duplicate
 * fallback where floor-skip (undefined → gate abstains + log) is the safe
 * alternative. No scored candidates → undefined (caller logs "floor skipped").
 */
/**
 * YUK-557 (F6) — single downgrade primitive for the action-synthesis loop. Every
 * downgrade (bad-target / per-kind / score-floor) forces KEEP_BOTH and prepends a
 * cause prefix to the prior reason with a "`. `" join, so action↔reason never
 * diverges in the WAL (spec Q1 论证 #6 / Lens A A5-1). The warn (Q3 detection) stays
 * at each call site — it is an observability side effect, not part of the reason.
 */
function downgradeToKeepBoth(
  prefix: string,
  orig: string,
): { action: ReconcileAction; reason: string } {
  return { action: 'KEEP_BOTH', reason: `${prefix}. ${orig}` };
}

/**
 * YUK-557 (Q1) — max candidate score for the RETRACT_NEW null-old_index fallback.
 * outlier-permissive approximation: `max` is the statistic MOST sensitive to a
 * single entity-boosted candidate spiking to ~0.99, so it biases toward PASSING
 * the floor. Acceptable because the null-old_index path is the noise∪duplicate
 * fallback where floor-skip (undefined → gate abstains + log) is the safe
 * alternative. No scored candidates → undefined (caller logs "floor skipped").
 */
function topCandidateScore(cands: CandidateEntry[]): number | undefined {
  const scores = cands.map((c) => c.score).filter((s): s is number => typeof s === 'number');
  return scores.length > 0 ? Math.max(...scores) : undefined;
}

/**
 * P2 (YUK-342): memory reconcile handler.
 *
 * Consumes a batch of new memory ids, searches for existing candidates per new
 * memory, asks GLM to judge KEEP_BOTH/SUPERSEDE/MERGE/RETRACT_NEW, writes
 * write-ahead audit rows, then consumes them without destructive mutation.
 *
 * Failure modes:
 *   1. LLM parse failure → catch ReconcileParseError → entire batch degrades to
 *      KEEP_BOTH (no destructive actions, only log rows).
 *   2. Write-ahead crash → loadUnappliedLog replays applied_at IS NULL rows at
 *      the start of every job (idempotent resume).
 *   3. Concurrency → singletonKey:'memory.reconcile.self' serializes per user.
 */
export function buildMemoryReconcileHandler(
  db: Db,
  deps: {
    memoryClient?: MemoryClient;
    /** Injectable for tests — defaults to judgeReconciliation */
    judge?: typeof judgeReconciliation;
    /**
     * YUK-557 (PR #699 CR-1) — injectable Mem0 client factory (default:
     * createMemoryClient). Tests inject a factory that throws so the m7 "client
     * unavailable" branch is DETERMINISTIC regardless of the shell env's Mem0 keys:
     * a bare createMemoryClient() would otherwise succeed on any machine that
     * happens to carry ZHIPU/DASHSCOPE keys, making m7 depend on ambient env.
     */
    createClient?: () => MemoryClient;
  } = {},
): (jobs: Job<{ memories: ReconcileMemInput[]; user_id: string }>[]) => Promise<void> {
  let memoryClient = deps.memoryClient;
  const judge = deps.judge ?? judgeReconciliation;
  const createClient = deps.createClient ?? createMemoryClient;
  return async (jobs) => {
    for (const job of jobs) {
      // F-1 equivalent — per-job try/catch prevents retry storm.
      try {
        const userId = job.data.user_id;
        const newMemInputs = job.data.memories ?? [];

        // Idempotent resume: replay any unapplied planned rows from prior runs.
        await applyPlannedRows(db, userId);

        if (newMemInputs.length === 0) continue;

        // Lazily init Mem0 client here (same F-4 pattern as brief regen —
        // missing key degrades gracefully, doesn't reject the whole job).
        let client = memoryClient;
        if (!client) {
          try {
            client = createClient();
            memoryClient = client;
          } catch (err) {
            console.warn(
              `[memory_reconcile] Mem0 client unavailable; skipping reconcile for ${newMemInputs.length} memories`,
              err,
            );
            continue;
          }
        }

        // Build the prompt inputs. The new memory's text/kind/created_ms are
        // THREADED from the ingest job (ReconcileMemInput) — NOT re-derived by
        // searching the opaque UUID (which embeds noise and rarely retrieves the
        // memory itself). Candidates ARE found by searching mem0 with the new
        // memory's extracted text (semantic neighbors), excluding this batch's
        // own new memories.
        const newMems: NewMemoryEntry[] = [];
        const candidatesByNew = new Map<number, CandidateEntry[]>();
        const newIdSet = new Set(newMemInputs.map((m) => m.id));

        for (let i = 0; i < newMemInputs.length; i++) {
          const input = newMemInputs[i];
          newMems.push({
            index: i,
            kind: input.kind,
            text: input.text,
            memory_id: input.id,
            created_ms: input.created_ms,
          });

          const cands: CandidateEntry[] = [];
          // Empty text → skip search (would embed ''); leaves no candidates → KEEP_BOTH.
          if (input.text.trim().length > 0) {
            const searchResult = await client.search(input.text, {
              topK: RECONCILE_TOP_K + 1,
              filters: { user_id: userId },
            });
            for (const r of searchResult?.results ?? []) {
              if (newIdSet.has(r.id)) continue; // exclude this batch's own new memories
              const cms = (r.metadata as Record<string, unknown> | undefined)?.created_ms;
              cands.push({
                index: cands.length,
                text: r.memory,
                memory_id: r.id,
                created_ms: typeof cms === 'number' ? cms : undefined,
                // YUK-557 (Q1): carry mem0's fused score for the structural gate.
                score: typeof r.score === 'number' ? r.score : undefined,
              });
            }
          }
          candidatesByNew.set(i, cands);
        }

        if (newMems.length === 0) continue;

        // GLM judgment — single call for all new memories + their candidates.
        let decisions: Awaited<ReturnType<typeof judge>>;
        try {
          decisions = await judge(newMems, candidatesByNew, {
            // YUK-359: record GLM reconcile cost (CNY). Best-effort — a ledger
            // write failure must never fail reconcile, so swallow + log.
            onUsage: (usage) => {
              void writeCostLedger(db, {
                task_kind: 'memory_reconcile',
                provider: 'glm',
                model: 'glm-5.2',
                cost: glmChatCostCny(usage.promptTokens, usage.completionTokens),
                currency: 'CNY',
                tokens_in: usage.promptTokens,
                tokens_out: usage.completionTokens,
              }).catch((err) => console.error('[memory_reconcile] writeCostLedger failed', err));
            },
          });
        } catch (err) {
          if (err instanceof ReconcileParseError) {
            // Failure mode 1: LLM parse failure → degrade entire batch to KEEP_BOTH.
            console.warn(
              `[memory_reconcile] LLM parse failed; degrading ${newMems.length} memories to KEEP_BOTH`,
              err.message,
            );
            const keepRows = newMems.map((m) =>
              makePlannedRow({
                user_id: userId,
                new_memory_id: m.memory_id,
                old_memory_id: null,
                action: 'KEEP_BOTH',
                reason: `LLM parse failure degraded: ${err.message}`,
                llm_raw: { error: err.message, raw: err.raw },
              }),
            );
            await insertPlannedRows(db, keepRows);
            for (const r of keepRows) await markApplied(db, r.id);
            continue;
          }
          // RetryableError/PermanentError — rethrow for pg-boss retry (or archive).
          throw err;
        }

        // Dedup decisions by new_index: if GLM returns multiple decisions for the
        // same new memory, only the first wins. A second planned row for the same
        // new_index would apply against already-mutated state (e.g. supersede a row
        // a prior decision already deleted), corrupting the batch. Keep the first,
        // warn-drop the rest.
        const seenNewIndex = new Set<number>();
        const uniqueDecisions = decisions.filter((d) => {
          if (seenNewIndex.has(d.new_index)) {
            console.warn(
              `[memory_reconcile] duplicate new_index ${d.new_index} dropped (action=${d.action}); first decision wins`,
            );
            return false;
          }
          seenNewIndex.add(d.new_index);
          return true;
        });

        // Write-ahead: insert planned rows BEFORE applying (crash safety).
        // Single UNIFIED action synthesis per decision, in fixed order:
        //   badTarget → per-kind (Q1b) → score-floor (Q1) → final.
        // reason / old_memory_id / prev_text ALL read the SAME final action, and
        // every downgrade rewrites `reason` symmetrically so action↔reason never
        // diverges in the WAL (spec M1 / Lens A A5-1/A5-2). Out-of-range indices
        // (LLM hallucination) degrade to KEEP_BOTH (existing semantics).
        const plannedRows: PlannedRow[] = [];
        for (const d of uniqueDecisions) {
          const newMem = newMems[d.new_index];
          const cands = candidatesByNew.get(d.new_index) ?? [];
          const oldMem = d.old_index != null ? cands[d.old_index] : undefined;
          // YUK-557 (PR #699 CR-4): an explicitly-provided old_index that fails to
          // resolve to a candidate (LLM-hallucinated out-of-range index) is invalid
          // for EVERY action — fail-safe downgrade to KEEP_BOTH before any deletion
          // decision. Without this, RETRACT_NEW (NOT in needsOldTarget) would let a
          // bogus old_index slip past badTarget and delete the new memory on a top-
          // score/abstain path. Pairs with F3/V3: after this guard the RETRACT_NEW
          // topCandidateScore fallback only ever sees the legal old_index===null state.
          const invalidOldIndex = d.old_index != null && !oldMem;
          const badTarget =
            !newMem ||
            invalidOldIndex ||
            (needsOldTarget(d.action) && !oldMem) ||
            (d.action === 'RETRACT_NEW' && !newMem);

          // Unified synthesis: badTarget → per-kind (Q1b) → score-floor (Q1) →
          // final. Every downgrade routes through downgradeToKeepBoth so
          // action↔reason never diverge in the WAL (F6 / Lens A A5-1/A5-2).
          let action: ReconcileAction = d.action;
          let reason = d.reason;

          // 1) bad-target degrade (out-of-range / unresolved old index → KEEP_BOTH)
          if (badTarget) {
            ({ action, reason } = downgradeToKeepBoth(
              `out-of-range index downgraded from ${d.action}`,
              d.reason,
            ));
          }

          // 2) per-kind gate (Q1b): weakness/event forbid MERGE
          if (action === 'MERGE' && newMem && kindForbidsMerge(newMem.kind)) {
            ({ action, reason } = downgradeToKeepBoth(
              `Per-kind guard (kind=${newMem.kind} forbids MERGE); downgraded from MERGE`,
              reason,
            ));
            console.warn(
              `[memory_reconcile] per-kind MERGE suppressed (kind=${newMem.kind}) new_index=${d.new_index}`,
            ); // Q3 detection
          }

          // 3) score floor (Q1): MERGE keys on the referenced candidate's score;
          // RETRACT_NEW keys on the referenced candidate, else the topCandidateScore
          // fallback ONLY when there is NO referenced candidate (old_index=null). A
          // referenced candidate that carries no score must NOT fall through to max —
          // it abstains (undefined → gate passes) + logs m8, symmetric with MERGE
          // (F3: max fallback is authorized only for old_index=null).
          // OCR (PR #699, triggers.ts:743) — if/else chain (repo bans nested
          // ternaries; semantics unchanged): MERGE keys on the referenced candidate;
          // RETRACT_NEW keys on the referenced candidate, else the topCandidateScore
          // fallback ONLY when there is NO referenced candidate (old_index===null);
          // every other action abstains (undefined).
          let referencedScore: number | undefined;
          if (action === 'MERGE') {
            referencedScore = oldMem?.score;
          } else if (action === 'RETRACT_NEW') {
            referencedScore = oldMem ? oldMem.score : topCandidateScore(cands);
          }
          const corroborated = passesStructuralCorroboration(action, referencedScore);
          // !corroborated already implies isHardDelete(action): passesStructural-
          // Corroboration only returns false for MERGE/RETRACT_NEW (dead action
          // conjunct removed, F6/V7).
          if (!corroborated) {
            ({ action, reason } = downgradeToKeepBoth(
              `Low structural corroboration (score=${referencedScore}); downgraded from ${action}`,
              reason,
            ));
            console.warn(
              `[memory_reconcile] score-floor downgrade (score=${referencedScore}) new_index=${d.new_index}`,
            ); // Q3 detection
          } else if (isHardDelete(action) && referencedScore === undefined) {
            console.warn(
              `[memory_reconcile] score-floor skipped (no candidate score) action=${action} new_index=${d.new_index}`,
            ); // m8
          }

          // 4) YUK-690 execution policy: model output is advisory only. Memory
          // events are user-authored text and therefore an untrusted prompt
          // boundary; no LLM recommendation may supersede, rewrite or delete a
          // stored memory without a separate human-approval surface. Preserve the
          // original decision in llm_raw below, but deterministically make the WAL
          // action non-destructive.
          if (action !== 'KEEP_BOTH') {
            const recommendedAction = action;
            ({ action, reason } = downgradeToKeepBoth(
              `Human approval required; blocked model-recommended ${recommendedAction}`,
              reason,
            ));
            console.warn(
              `[memory_reconcile] destructive recommendation blocked action=${recommendedAction} new_index=${d.new_index}`,
            );
          }

          plannedRows.push(
            makePlannedRow({
              user_id: userId,
              new_memory_id: newMem?.memory_id ?? null,
              old_memory_id: action === 'KEEP_BOTH' ? null : (oldMem?.memory_id ?? null),
              action,
              reason,
              // Persist recency + the LLM decision (incl. merged_text for MERGE) +
              // Q1 gate observability (for future data-driven floor calibration).
              llm_raw: {
                ...d,
                execution_policy: 'human_approval_required',
                recommended_action: d.action,
                new_created_ms: newMem?.created_ms ?? null,
                referenced_score: referencedScore ?? null,
                structurally_corroborated: corroborated,
              },
              prev_text: null,
              prev_metadata: null,
            }),
          );
        }
        await insertPlannedRows(db, plannedRows);

        // Apply phase: consume recommendations without mutating mem0.
        await applyPlannedRows(db, userId);
      } catch (err) {
        // Retryable failures (GLM timeout / 5xx / transient provider error) MUST
        // propagate so pg-boss retries the job (enqueueMemoryReconcile sets
        // retryLimit/retryDelay/retryBackoff). The retry is safe: the common
        // RetryableError site is judge() (BEFORE any planned rows are inserted),
        // so the batch simply re-runs; and any planned rows from a PRIOR run
        // replay idempotently via the applyPlannedRows at job start (:584's call
        // is end-of-apply; the load-bearing replay is the one at job start, not
        // rows from this attempt). Swallowing here (the prior behavior) made the
        // job report success → no retry → this batch silently never reconciled.
        if (err instanceof RetryableError) throw err;
        // YUK-353 (item 2): PermanentError (judge auth 401/403, 4xx, non-JSON 2xx)
        // must ALSO propagate. Previously it fell into the swallow branch below →
        // the job reported success → pg-boss never archived it and no failed
        // outcome was recorded, so an auth/config breakage looked like a healthy
        // no-op reconcile. Rethrowing lets pg-boss exhaust retries and archive the
        // job (terminal failure surfaces in the boss archive / admin jobs面).
        // Resume safety is unchanged: any planned rows from a PRIOR run still
        // replay idempotently via applyPlannedRows at job start.
        if (err instanceof PermanentError) throw err;
        // Other non-retryable failures (unexpected errors, not in our error
        // taxonomy): leave planned rows intact for idempotent resume on next job.
        console.error(
          '[memory_reconcile] job failed (non-retryable); planned rows left for resume',
          err,
        );
      }
    }
  };
}

/**
 * Consume write-ahead planned rows (applied_at IS NULL) for a user.
 *
 * YUK-690: reconciliation is recommendation-only. New synthesis stores KEEP_BOTH;
 * legacy destructive rows are marked applied without touching mem0 so deployment
 * cannot replay a pre-fix LLM decision into a mutation.
 */
async function applyPlannedRows(db: Db, userId: string): Promise<void> {
  const pending = await loadUnappliedLog(db, userId);
  if (pending.length === 0) return;

  for (const row of pending) {
    if (row.action !== 'KEEP_BOTH') {
      console.warn(
        `[memory_reconcile] legacy destructive WAL row blocked action=${row.action} log_id=${row.id}`,
      );
    }
    await markApplied(db, row.id);
  }
}

export function buildMemoryBriefSweepHandler(
  db: Db,
  boss: Pick<BossLike, 'send'>,
  // P5.2 (PR #218 fix) — optional injected `now`. Computed ONCE per sweep and
  // shared across detection + the per-subject regen jobs it enqueues, so a
  // never-built subject's 30d lookback floor is identical at detection time and
  // reload time (closes the 30d-edge race; also makes fixed-NOW tests
  // deterministic regardless of wall-clock drift). Defaults to a fresh clock.
  opts?: { now?: Date },
): (jobs: Job<object>[]) => Promise<void> {
  return async () => {
    const now = opts?.now ?? new Date();

    // BR-6 — global + any existing stale (non-subject) brief rows: unchanged
    // 24h-stale gate. `listStaleBriefScopes` now EXCLUDES `subject:*` rows
    // (brief.ts), so subject refresh is owned entirely by the capped per-subject
    // path below and is never enqueued uncapped via this loop. The global brief
    // is always enqueued here and is NOT subject to maxSubjectsPerRun.
    for (const scopeKey of await listStaleBriefScopes(db, now)) {
      await enqueueBriefRegen(boss, scopeKey);
    }

    // P5.2 (YUK-143) — additive activity-gated per-subject layer (§3.3). Find
    // subjects whose knowledge-resolved activity is newer than their brief's
    // refreshed_at (or never-built within the lookback window), sort by activity
    // recency DESC, and enqueue only the top maxSubjectsPerRun (BR-9). Deferred
    // subjects remain active and are eligible again next run (no starvation).
    // enqueueBriefRegen dedups per scope_key on a 6-min singleton window.
    const activeSubjects = await listActiveSubjectsSinceRefresh(db, {
      lookbackDays: BRIEF_REFRESH_LOOKBACK_DAYS,
      now,
    });
    for (const subject of selectSubjectsForRun(
      activeSubjects,
      BRIEF_REFRESH_BUDGET.maxSubjectsPerRun,
    )) {
      // Thread the sweep's `now` so the regen job reloads on the SAME 30d floor.
      await enqueueBriefRegen(boss, subject.scopeKey, now);
    }
  };
}

// ADR-0021 — transactional outbox poll handler. Cron fires every minute;
// SELECT...FOR UPDATE SKIP LOCKED grabs a batch of pending event rows
// (`ingest_at IS NULL`), enqueues each into MEMORY_EVENT_INGEST_QUEUE, and
// stamps `ingest_at = now()` in the SAME transaction — so concurrent pollers
// never double-enqueue and a worker crash before commit reverts the stamp.
export function buildMemoryIngestOutboxPollHandler(
  db: Db,
  boss: Pick<BossLike, 'send'>,
): (jobs: Job<object>[]) => Promise<void> {
  return async () => {
    await db.transaction(async (tx) => {
      const pending = await tx
        .select({ id: event.id })
        .from(event)
        .where(isNull(event.ingest_at))
        .orderBy(event.created_at)
        .limit(OUTBOX_POLL_BATCH)
        .for('update', { skipLocked: true });
      if (pending.length === 0) return;
      for (const row of pending) {
        await enqueueEventMemoryIngest(boss, row.id, { db: fromPgBossDrizzleTx(tx) });
      }
      await tx
        .update(event)
        .set({ ingest_at: new Date() })
        .where(
          inArray(
            event.id,
            pending.map((r) => r.id),
          ),
        );
    });
  };
}

// ADR-0021 — recovery sweep. Hourly cron drains any pending rows the
// per-minute poller missed (worker outage, fast burst > batch limit).
// Calls the same per-batch poller in a loop until a cycle returns empty,
// with a safety cap to prevent runaway loops on pathological state.
const OUTBOX_RECOVER_MAX_CYCLES = 1000;
export function buildMemoryIngestOutboxRecoverHandler(
  db: Db,
  boss: Pick<BossLike, 'send'>,
): (jobs: Job<object>[]) => Promise<void> {
  const drainOnce = buildMemoryIngestOutboxPollHandler(db, boss);
  return async () => {
    for (let cycle = 0; cycle < OUTBOX_RECOVER_MAX_CYCLES; cycle += 1) {
      const before = await countPendingIngest(db);
      if (before === 0) return;
      await drainOnce([]);
      const after = await countPendingIngest(db);
      if (after >= before) return; // no progress — bail to avoid infinite loop
    }
  };
}

async function countPendingIngest(db: Db): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(event)
    .where(isNull(event.ingest_at));
  return rows[0]?.count ?? 0;
}

async function defaultGenerateBrief(): Promise<never> {
  throw new Error('memory brief LLM generator is not configured');
}

export async function registerMemoryHandlers(
  boss: BossLike,
  db: Db,
  deps: {
    memoryClient?: MemoryClient;
    generateBrief?: GenerateBrief;
  } = {},
): Promise<void> {
  const generateBrief = deps.generateBrief ?? defaultGenerateBrief;

  // F-2 (YUK-185) — the XIAOMI_API_KEY boot WARN used to live HERE, but tests
  // also call registerMemoryHandlers (with a stubbed generateBrief), so it
  // emitted a false "brief regen will fail" line in every such test. PR #232
  // review (FIX #6) moved the one-time WARN to the prod entry point
  // (scripts/worker.ts) — the only boot path that actually runs the cron — so
  // the operator still gets the signal and tests stay quiet.

  // YUK-248: memory_event_ingest invokes mem0's LLM extraction + embedding
  // pipeline. Give it the shared LLM expiry/retention/retry policy and a DLQ
  // instead of pg-boss's 15-minute/14-day/no-DLQ defaults.
  await createJobQueue(boss, MEMORY_EVENT_INGEST_QUEUE, EXPIRE_LLM);
  await boss.work(
    MEMORY_EVENT_INGEST_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildMemoryEventIngestHandler(db, boss, { memoryClient: deps.memoryClient }),
  );

  await createJobQueue(boss, MEMORY_BRIEF_REGEN_QUEUE, EXPIRE_LLM);
  await boss.work(
    MEMORY_BRIEF_REGEN_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildMemoryBriefRegenHandler(db, { memoryClient: deps.memoryClient, generateBrief }),
  );

  await createOrUpdateQueue(boss, MEMORY_BRIEF_SWEEP_QUEUE, FAST_QUEUE_OPTS);
  await boss.work(MEMORY_BRIEF_SWEEP_QUEUE, buildMemoryBriefSweepHandler(db, boss));
  await boss.schedule(MEMORY_BRIEF_SWEEP_QUEUE, '0 3 * * *', {}, { tz: 'Asia/Shanghai' });

  // ADR-0021 outbox: per-minute poller drains pending ingest rows; hourly
  // recovery sweep catches anything missed (worker outage, batch overflow).
  await createOrUpdateQueue(boss, MEMORY_INGEST_OUTBOX_POLL_QUEUE, FAST_QUEUE_OPTS);
  await boss.work(MEMORY_INGEST_OUTBOX_POLL_QUEUE, buildMemoryIngestOutboxPollHandler(db, boss));
  await boss.schedule(MEMORY_INGEST_OUTBOX_POLL_QUEUE, '* * * * *', {}, { tz: 'UTC' });

  await createOrUpdateQueue(boss, MEMORY_INGEST_OUTBOX_RECOVER_QUEUE, FAST_QUEUE_OPTS);
  await boss.work(
    MEMORY_INGEST_OUTBOX_RECOVER_QUEUE,
    buildMemoryIngestOutboxRecoverHandler(db, boss),
  );
  await boss.schedule(MEMORY_INGEST_OUTBOX_RECOVER_QUEUE, '0 * * * *', {}, { tz: 'UTC' });

  // P2 (YUK-342): reconcile queue — event-driven (no cron schedule).
  // memory_reconcile is newer than the original YUK-248 inventory but has the
  // same paid-LLM failure mode, so keep the invariant exhaustive for every
  // queue owned by this registrar.
  await createJobQueue(boss, MEMORY_RECONCILE_QUEUE, EXPIRE_LLM);
  await boss.work(
    MEMORY_RECONCILE_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildMemoryReconcileHandler(db, { memoryClient: deps.memoryClient }),
  );
}
