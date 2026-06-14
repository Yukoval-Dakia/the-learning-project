import { eq, inArray, isNull, sql } from 'drizzle-orm';
import { type DrizzleTransactionLike, type Job, fromDrizzle } from 'pg-boss';

import { RetryableError } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { BRIEF_REFRESH_BUDGET } from '@/server/ai/tools/budgets';
import { isQueueCreateRace } from '@/server/boss/client';
import {
  listActiveSubjectsSinceRefresh,
  loadSubjectBriefEvents,
  selectSubjectsForRun,
  subjectScopeHasNewEvidence,
} from './active-subjects';
import {
  type GenerateBrief,
  listStaleBriefScopes,
  regenerateMemoryBrief,
  scopeHasNewEvidence,
} from './brief';
import {
  type MemoryClient,
  type MemoryEventInput,
  createMem0Config,
  createMemoryClient,
} from './client';
import {
  type CandidateEntry,
  type NewMemoryEntry,
  ReconcileParseError,
  judgeReconciliation,
} from './reconcile-llm';
import {
  hardDeleteMemory,
  insertPlannedRows,
  loadUnappliedLog,
  makePlannedRow,
  markApplied,
  rewriteMemoryText,
  softSupersede,
} from './reconcile-store';

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

type BossLike = {
  createQueue?(name: string): Promise<unknown>;
  work(name: string, ...args: unknown[]): Promise<unknown>;
  schedule(name: string, cron: string, data: object, options: object): Promise<unknown>;
  send(name: string, data: object, options?: object): Promise<string | null>;
};

/**
 * Create a memory queue, tolerating the YUK-259 concurrent-create race.
 *
 * The memory_* queues are registered here (not via handlers.ts's
 * createOrUpdateQueue), so they need the same 23505 guard: when the app's
 * in-process boss and the worker register at once — or `next dev` HMR
 * re-evaluates this module on every recompile — pg-boss's createQueue INSERT can
 * race past its own ON CONFLICT and raise `queue_pkey` `already exists`. That
 * means the queue already exists (the desired end state), so swallow it. Unlike
 * handlers.ts there is no per-queue config to reconcile here (memory queue
 * expire/retention tuning is tracked separately), so a benign race is a pure
 * no-op. Any other error propagates.
 */
async function safeCreateQueue(boss: BossLike, name: string): Promise<void> {
  try {
    await boss.createQueue?.(name);
  } catch (err) {
    if (!isQueueCreateRace(err)) throw err;
    console.warn(
      `[memory] createQueue('${name}') hit a concurrent create race (23505 queue_pkey) — queue already exists, continuing (YUK-259)`,
    );
  }
}

type ProjectDrizzleTx = {
  execute(query: unknown): Promise<unknown>;
};

function hasRowsResult(value: unknown): value is { rows: unknown[] } {
  return (
    typeof value === 'object' && value !== null && Array.isArray((value as { rows?: unknown }).rows)
  );
}

function fromPgBossDrizzleTx(tx: ProjectDrizzleTx) {
  // pg-boss's Drizzle adapter expects node-postgres-style `{ rows }`, while
  // this repo uses drizzle-orm/postgres-js where `execute()` returns the row
  // array directly. Normalize only this driver shape before handing it to
  // pg-boss so `send(..., { db })` stays in the caller transaction.
  const txWithRows: DrizzleTransactionLike = {
    async execute(query) {
      const result = await tx.execute(query);
      if (Array.isArray(result)) return { rows: result };
      if (hasRowsResult(result)) return result;
      throw new Error('pg-boss Drizzle tx adapter received an unsupported execute() result');
    },
  };
  return fromDrizzle(txWithRows, sql);
}

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
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    payload: row.payload,
    affected_scopes: row.affected_scopes,
    created_at: row.created_at,
    kind: mapEventActionToKind(row.action),
  };
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
      // P2 (YUK-342): capture add() return — results[].id + results[].memory are
      // the extracted memory rows (mem0 infer:true). Fan-out brief regen, then
      // enqueue reconcile for the new memory ids.
      const memResult = await client.addEventMemory(row);
      for (const scopeKey of row.affected_scopes) {
        await enqueueBriefRegen(boss, scopeKey);
      }
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
            const result = await memoryClient.search(`memory brief ${scopeKey}`, {
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
 * P2 (YUK-342): memory reconcile handler.
 *
 * Consumes a batch of new memory ids, searches for existing candidates per new
 * memory, asks GLM to judge KEEP_BOTH/SUPERSEDE/MERGE/RETRACT_NEW, writes
 * write-ahead planned rows, then applies them.
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
    /** Injectable for tests — mem0 collection table name (default: from config) */
    collectionName?: string;
  } = {},
): (jobs: Job<{ memories: ReconcileMemInput[]; user_id: string }>[]) => Promise<void> {
  let memoryClient = deps.memoryClient;
  const judge = deps.judge ?? judgeReconciliation;
  const collectionName = deps.collectionName;
  return async (jobs) => {
    for (const job of jobs) {
      // F-1 equivalent — per-job try/catch prevents retry storm.
      try {
        const userId = job.data.user_id;
        const newMemInputs = job.data.memories ?? [];

        // Idempotent resume: replay any unapplied planned rows from prior runs.
        await applyPlannedRows(db, userId, collectionName);

        if (newMemInputs.length === 0) continue;

        // Lazily init Mem0 client here (same F-4 pattern as brief regen —
        // missing key degrades gracefully, doesn't reject the whole job).
        let client = memoryClient;
        if (!client) {
          try {
            client = createMemoryClient();
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
              });
            }
          }
          candidatesByNew.set(i, cands);
        }

        if (newMems.length === 0) continue;

        // GLM judgment — single call for all new memories + their candidates.
        let decisions: Awaited<ReturnType<typeof judge>>;
        try {
          decisions = await judge(newMems, candidatesByNew);
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
        // Map decisions to log rows, resolving old_index → memory_id. Out-of-range
        // indices (LLM hallucination) degrade that decision to a safe KEEP_BOTH
        // rather than a null-id no-op or a wrong-target supersede.
        const plannedRows = uniqueDecisions.map((d) => {
          const newMem = newMems[d.new_index];
          const cands = candidatesByNew.get(d.new_index) ?? [];
          const oldMem = d.old_index != null ? cands[d.old_index] : undefined;
          const destructive = d.action === 'SUPERSEDE' || d.action === 'MERGE';
          const badTarget =
            !newMem || (destructive && !oldMem) || (d.action === 'RETRACT_NEW' && !newMem);
          const action = badTarget ? 'KEEP_BOTH' : d.action;
          return makePlannedRow({
            user_id: userId,
            new_memory_id: newMem?.memory_id ?? null,
            old_memory_id: action === 'KEEP_BOTH' ? null : (oldMem?.memory_id ?? null),
            action,
            reason: badTarget
              ? `out-of-range index degraded from ${d.action}; ${d.reason}`
              : d.reason,
            // Persist the new memory's created_ms (recency) + the LLM decision
            // (incl. merged_text for MERGE) for the apply step + audit.
            llm_raw: { ...d, new_created_ms: newMem?.created_ms ?? null },
          });
        });
        await insertPlannedRows(db, plannedRows);

        // Apply phase: execute actions, then mark applied.
        await applyPlannedRows(db, userId, collectionName);
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
        // Non-retryable: leave planned rows intact for idempotent resume on next job.
        console.error(
          '[memory_reconcile] job failed (non-retryable); planned rows left for resume',
          err,
        );
      }
    }
  };
}

/**
 * Apply write-ahead planned rows (applied_at IS NULL) for a user.
 * Idempotent: hardDelete 'not found' swallowed, already-applied rows skipped.
 */
async function applyPlannedRows(
  db: Db,
  userId: string,
  injectedCollectionName?: string,
): Promise<void> {
  const pending = await loadUnappliedLog(db, userId);
  if (pending.length === 0) return;

  const collectionName =
    injectedCollectionName ??
    createMem0Config().vectorStore.config.collectionName ??
    'learning_project_memories';

  for (const row of pending) {
    const now = Date.now();
    const llmRaw = row.llm_raw as {
      new_created_ms?: number | null;
      merged_text?: string | null;
    } | null;
    // created_ms stamped onto the superseded row = the NEW memory's created_ms
    // (recency of the superseding fact), threaded via llm_raw; fall back to now.
    const newCreatedMs = typeof llmRaw?.new_created_ms === 'number' ? llmRaw.new_created_ms : now;
    switch (row.action) {
      case 'KEEP_BOTH':
        // No side effects — just mark applied.
        break;
      case 'SUPERSEDE':
        if (row.old_memory_id && row.new_memory_id) {
          await softSupersede(db, collectionName, {
            oldMemoryId: row.old_memory_id,
            supersededByNewId: row.new_memory_id,
            invalidAtMs: now,
            createdMs: newCreatedMs,
          });
        }
        break;
      case 'MERGE':
        if (row.old_memory_id && row.new_memory_id) {
          const mergedText =
            typeof llmRaw?.merged_text === 'string' ? llmRaw.merged_text.trim() : '';
          if (mergedText.length > 0) {
            // Rewrite the OLD (surviving) memory's text to absorb the new one,
            // then delete new. The survivor stays LIVE — rewriteMemoryText writes
            // only payload.data + created_ms, NOT superseded_by/invalid_at — so
            // the merged memory is NOT filtered out by the P3 read path (the
            // YUK-342 PR #405 bug: softSupersedeWithText marked the survivor
            // superseded, hiding the merge result from reads).
            await rewriteMemoryText(db, collectionName, {
              memoryId: row.old_memory_id,
              mergedText,
              createdMs: newCreatedMs,
            });
            await hardDeleteMemory(db, collectionName, row.new_memory_id);
          } else {
            // Defensive (parse should require merged_text for MERGE): no merged
            // text → mark old superseded WITHOUT rewriting/dropping new (no data loss).
            await softSupersede(db, collectionName, {
              oldMemoryId: row.old_memory_id,
              supersededByNewId: row.new_memory_id,
              invalidAtMs: now,
              createdMs: newCreatedMs,
            });
          }
        }
        break;
      case 'RETRACT_NEW':
        if (row.new_memory_id) {
          await hardDeleteMemory(db, collectionName, row.new_memory_id);
        }
        break;
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

  await safeCreateQueue(boss, MEMORY_EVENT_INGEST_QUEUE);
  await boss.work(
    MEMORY_EVENT_INGEST_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildMemoryEventIngestHandler(db, boss, { memoryClient: deps.memoryClient }),
  );

  await safeCreateQueue(boss, MEMORY_BRIEF_REGEN_QUEUE);
  await boss.work(
    MEMORY_BRIEF_REGEN_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildMemoryBriefRegenHandler(db, { memoryClient: deps.memoryClient, generateBrief }),
  );

  await safeCreateQueue(boss, MEMORY_BRIEF_SWEEP_QUEUE);
  await boss.work(MEMORY_BRIEF_SWEEP_QUEUE, buildMemoryBriefSweepHandler(db, boss));
  await boss.schedule(MEMORY_BRIEF_SWEEP_QUEUE, '0 3 * * *', {}, { tz: 'Asia/Shanghai' });

  // ADR-0021 outbox: per-minute poller drains pending ingest rows; hourly
  // recovery sweep catches anything missed (worker outage, batch overflow).
  await safeCreateQueue(boss, MEMORY_INGEST_OUTBOX_POLL_QUEUE);
  await boss.work(MEMORY_INGEST_OUTBOX_POLL_QUEUE, buildMemoryIngestOutboxPollHandler(db, boss));
  await boss.schedule(MEMORY_INGEST_OUTBOX_POLL_QUEUE, '* * * * *', {}, { tz: 'UTC' });

  await safeCreateQueue(boss, MEMORY_INGEST_OUTBOX_RECOVER_QUEUE);
  await boss.work(
    MEMORY_INGEST_OUTBOX_RECOVER_QUEUE,
    buildMemoryIngestOutboxRecoverHandler(db, boss),
  );
  await boss.schedule(MEMORY_INGEST_OUTBOX_RECOVER_QUEUE, '0 * * * *', {}, { tz: 'UTC' });

  // P2 (YUK-342): reconcile queue — event-driven (no cron schedule).
  await safeCreateQueue(boss, MEMORY_RECONCILE_QUEUE);
  await boss.work(
    MEMORY_RECONCILE_QUEUE,
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildMemoryReconcileHandler(db, { memoryClient: deps.memoryClient }),
  );
}
