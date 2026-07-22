// YUK-406 Phase 0 (关系脑 thin slice) / YUK-440 (A13) — nightly 教研例会
// (research-meeting) propose handler.
//
// Structurally a clone of goal_scope_propose_nightly.ts: a thin candidate-picker +
// dedup gate + a bounded parallel producer batch (NOT an MCP tool-agent loop). The job is
// the SINGLE proposer of conjectures. It does NOT use a DomainTool / MCP server —
// it calls induceConjecture (the Opus self-consistency orchestrator) + writeAiProposal
// directly, exactly like goal_scope calls runGoalScopeAndWrite. Cloning dreaming_nightly
// (an MCP agent loop) would be wrong: that loop's cost-cap only triggers on tool-calls,
// and this deterministic flow never calls MCP tools (a13-design critic #1).
//
// Per run:
//   1. (PRE-LLM, retryable) read recent failures + per-KC mastery projection + the
//      set of cause×KC keys that already have a PENDING conjecture (dedup);
//   2. deterministic 取证 (gatherConjectureEvidence) → salience-sorted cells;
//   3. take the top-K cells (RESEARCH_MEETING_MAX_CONJECTURES) — the structural
//      per-run propose cap;
//   4. for each cell: induceConjecture (Opus N=3 self-consistency on the anthropic-sub
//      OAuth lane) → one ConjectureDraft + A13 fields → writeAiProposal (propose-only).
//
// Failure asymmetry (D7 / F-1): the PRE-LLM reads run OUTSIDE the per-cell swallow —
// a throw there is a legit retryable DB fault that propagates to the builder's
// rethrow so pg-boss retries. The per-cell LLM half is swallow-safe (one cell's
// failure logs a retryable AI ledger row and continues; partial progress is fine).
//
// ND-5: this job NEVER writes FSRS state. The conjecture is propose-only — the owner
// accepts/edits/rejects in the inbox; scoring + label flips are DEFERRED (PR-2 /
// ADR-0046). The proposal only SNAPSHOTS predicted_p (the claim's bet) +
// baseline_p_at_induction (the number to beat); it does not move any number.

import { type WriteEventInput, writeEvent } from '@/kernel/events';
import type { Job } from 'pg-boss';

import { writeRetryableAiFailureLedger } from '@/capabilities/knowledge/server/ai_failure_log';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { conjectureKey, gatherConjectureEvidence } from '@/server/conjectures/evidence';
import type { EvidenceCell } from '@/server/conjectures/evidence';
import { type FailureAttempt, getFailureAttempts } from '@/server/events/queries';
import { getMasteryProjection } from '@/server/mastery/state';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { type WriteAiProposalInput, writeAiProposal } from '@/server/proposals/writer';

import { type InduceConjectureResult, induceConjecture } from '@/server/agency/conjecture/induce';
import {
  type ReconcileResult,
  reconcileConjecturePredictions,
} from '@/server/conjectures/reconcile';

/** Structural per-run propose cap (top-K salient cells → at most K conjectures). */
export const RESEARCH_MEETING_MAX_CONJECTURES = 3;
/** N self-consistency samples per conjecture (D2 — Opus agreement tally). */
export const RESEARCH_MEETING_SAMPLES = 3;
/** Recency window for the failure scan. */
export const RESEARCH_MEETING_WINDOW_DAYS = 14;
/** actor_ref stamped on the trigger / scan events + each conjecture proposal. */
export const RESEARCH_MEETING_ACTOR = 'research_meeting';

export interface ResearchMeetingResult {
  /** top-K cells inducted this run (== conjectures attempted). */
  considered: number;
  /** conjectures actually proposed (a cell whose induction failed is dropped). */
  conjectures_created: number;
  /** pending conjectures already open at run start (the dedup base). */
  pending_before: number;
  /** prior probe outcomes scored + ledger-updated this run (U8 reconcile, A13). */
  reconciled: number;
  /** probe outcomes skipped this run (dangling / malformed / unreadable conjecture ref). */
  reconcile_skipped: number;
  /** total Opus cost across the run's inductions, USD. */
  cost_usd: number;
  /**
   * the run's anchor event id (provenance + scan subject). `''` sentinel when the
   * run early-returned on an empty night (zero top cells → no anchor event written).
   */
  trigger_event_id: string;
}

type WriteEventFn = (db: Db, input: WriteEventInput) => Promise<string>;
type WriteAiProposalFn = (db: Db, input: WriteAiProposalInput) => Promise<string>;
type InduceConjectureFn = typeof induceConjecture;
type GetFailureAttemptsFn = typeof getFailureAttempts;
type GetMasteryProjectionFn = typeof getMasteryProjection;
type WriteRetryableAiFailureLedgerFn = (db: Db, taskKind: string) => Promise<void>;

export interface ResearchMeetingDeps {
  now?: () => Date;
  getFailureAttemptsFn?: GetFailureAttemptsFn;
  getMasteryProjectionFn?: GetMasteryProjectionFn;
  /** dedup base: cause×KC keys with a PENDING conjecture (default reads the inbox). */
  loadKnownConjectureKeysFn?: (db: Db) => Promise<Set<string>>;
  /** injected runner — defaults to the real db-bound runTask. */
  runTaskFn?: TaskTextRunFn;
  induceConjectureFn?: InduceConjectureFn;
  writeAiProposalFn?: WriteAiProposalFn;
  writeEventFn?: WriteEventFn;
  writeRetryableAiFailureLedgerFn?: WriteRetryableAiFailureLedgerFn;
  /** U8 (A13): score prior probe outcomes → prediction_score event + typed-ledger. */
  reconcileFn?: (db: Db) => Promise<ReconcileResult>;
}

/**
 * Pending-conjecture dedup: cause×KC keys that already carry a PENDING conjecture
 * proposal, so the same belief is not re-raised while one is still open. Uses the
 * inbox status derivation (listProposalInboxRows) — a dismissed/accepted conjecture
 * drops out of `pending`, so its evidence can be re-raised if it recurs.
 */
async function defaultLoadKnownConjectureKeys(db: Db): Promise<Set<string>> {
  const rows = await listProposalInboxRows(db, { status: 'pending', kind: 'conjecture' });
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.payload.kind === 'conjecture') {
      const change = row.payload.proposed_change;
      keys.add(conjectureKey(change.cause_category, change.knowledge_id));
    }
  }
  return keys;
}

/**
 * Real runner: wrap runTask and INJECT `db` into the ctx that induceConjecture
 * supplies ({ override, outputFormat }). induceConjecture stays db-free (unit
 * testable); the job is the seam that binds db (same role as runGoalScopeAndWrite).
 */
function makeDefaultRunTaskFn(db: Db): TaskTextRunFn {
  return makeRunTaskFn(db);
}

/** Assemble the propose-only conjecture payload (deterministic cell facts + LLM draft). */
function buildConjectureProposalInput(
  cell: EvidenceCell,
  induced: InduceConjectureResult,
  triggerEventId: string,
): WriteAiProposalInput {
  // Memory policy (YUK-515): conjecture proposals intentionally remain outbox-eligible.
  // Unlike probe/scan bookkeeping, this is a durable, evidence-backed belief about the
  // learner that the memory layer should retain. writeAiProposal therefore receives no
  // ingest_at opt-out; owner accept/edit remains the later calibration boundary.
  return {
    actor_ref: RESEARCH_MEETING_ACTOR,
    outcome: 'partial',
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: cell.knowledge_id },
      // The 2nd-person belief IS the card's reason — shown whole, never truncated.
      reason_md: induced.draft.claim_md,
      // Provenance reuses the attempt event ids (no separate misconception store).
      evidence_refs: cell.evidence_event_ids.map((id) => ({ kind: 'event' as const, id })),
      proposed_change: {
        claim_md: induced.draft.claim_md,
        // Deterministic cell facts win over the LLM echo (cause/recurrence are the
        // ground truth the evidence_refs back; the draft only restates them).
        knowledge_id: cell.knowledge_id,
        cause_category: cell.cause_category,
        confidence: induced.confidence, // internal sort only — NEVER rendered as a number
        recurrence_count: cell.recurrence_count,
        probe_md: induced.draft.probe_md,
        // conjecture-wire #13 — single-writer judge gold reference flows draft →
        // proposal change → acceptConjectureProposal → serveProbeOnce.referenceMd.
        probe_reference_md: induced.draft.probe_reference_md,
        discriminating: induced.draft.discriminating,
        corrected_by_owner: false,
        // A13 (YUK-440): the falsifiable bet + the number it must later beat.
        predicted_p: induced.draft.predicted_p,
        baseline_p_at_induction: cell.baseline_p ?? 0.5, // 0.5 = cold-start neutral
      },
      cooldown_key: `conjecture:${cell.key}`,
    },
    caused_by_event_id: triggerEventId,
    // Keep the scalar correlation column for the primary sample, and retain the
    // complete self-consistency evidence trail in the proposal event payload.
    event_override: {
      action: 'experimental:proposal',
      subject_kind: 'mind_model',
      subject_id: cell.knowledge_id,
      payload: { induction_task_run_ids: induced.task_run_ids },
    },
    task_run_id: induced.task_run_ids[0] ?? null,
    cost_usd: induced.cost_usd,
  };
}

export async function runResearchMeetingNightly(
  db: Db,
  deps: ResearchMeetingDeps = {},
): Promise<ResearchMeetingResult> {
  const now = deps.now?.() ?? new Date();
  const getFailureAttemptsFn = deps.getFailureAttemptsFn ?? getFailureAttempts;
  const getMasteryProjectionFn = deps.getMasteryProjectionFn ?? getMasteryProjection;
  const loadKnownConjectureKeysFn =
    deps.loadKnownConjectureKeysFn ?? defaultLoadKnownConjectureKeys;
  const induceConjectureFn = deps.induceConjectureFn ?? induceConjecture;
  const writeAiProposalFn = deps.writeAiProposalFn ?? writeAiProposal;
  const writeEventFn = deps.writeEventFn ?? writeEvent;
  const writeRetryableAiFailureLedgerFn =
    deps.writeRetryableAiFailureLedgerFn ?? writeRetryableAiFailureLedger;
  const runTaskFn = deps.runTaskFn ?? makeDefaultRunTaskFn(db);
  const reconcileFn = deps.reconcileFn ?? ((d: Db) => reconcileConjecturePredictions(d));

  // ── A13 reconcile (U8): score PRIOR probe outcomes against their conjecture's
  // prediction → append LOG-only prediction_score events + advance the typed-ledger
  // (FLIP-inert). Runs BEFORE the propose half: deterministic DB work, idempotent
  // (already-scored probes are excluded by the reader), and a throw here is a legit
  // retryable DB fault that propagates so pg-boss retries the whole job.
  const reconcileResult = await reconcileFn(db);
  // Surface the aggregate skip count — a non-zero value flags data-quality drift (dangling /
  // unreadable conjecture refs) that the per-probe console.warn alone makes easy to miss.
  if (reconcileResult.skipped > 0) {
    console.warn('[research_meeting_nightly] reconcile skipped probes', reconcileResult.skipped);
  }

  // ── PRE-LLM reads (OUTSIDE the per-cell swallow — a throw here is retryable) ──
  const since = new Date(now.getTime() - RESEARCH_MEETING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const failures: FailureAttempt[] = await getFailureAttemptsFn(db, {
    includeReviewFailures: true,
    since,
  });
  const kcIds = [...new Set(failures.flatMap((f) => f.referenced_knowledge_ids))];
  const masteryByKnowledgeId =
    kcIds.length > 0 ? await getMasteryProjectionFn(db, kcIds) : new Map();
  const knownConjectureKeys = await loadKnownConjectureKeysFn(db);

  // ── Deterministic 取证 + top-K salience cap ──
  const cells = gatherConjectureEvidence({ failures, masteryByKnowledgeId, knownConjectureKeys });
  const topCells = cells.slice(0, RESEARCH_MEETING_MAX_CONJECTURES);

  // Empty-night early return (YUK-377 复审 §3.5): zero top cells (no recurring failure
  // evidence, or every cell deduped by a pending conjecture) means the propose half has
  // nothing to anchor. Skip the trigger + scan events entirely — even though YUK-515 now
  // opts both out of memory, two empty-run rows would still add useless audit churn.
  // MUST stay AFTER the reconcile call above:
  // the deterministic settlement half is never skipped. Zero external consumers of these
  // events exist (grep-verified 2026-07-06), so skipping them changes no downstream reader.
  if (topCells.length === 0) {
    return {
      considered: 0,
      conjectures_created: 0,
      pending_before: knownConjectureKeys.size,
      reconciled: reconcileResult.reconciled,
      reconcile_skipped: reconcileResult.skipped,
      cost_usd: 0,
      trigger_event_id: '',
    };
  }

  // Anchor the run (provenance for each proposal + the scan subject).
  const triggerEventId = `research_meeting_${newId()}`;
  await writeEventFn(db, {
    id: triggerEventId,
    actor_kind: 'agent',
    actor_ref: RESEARCH_MEETING_ACTOR,
    action: 'experimental:trigger_research_meeting',
    subject_kind: 'query',
    subject_id: triggerEventId,
    outcome: 'success',
    payload: {
      window_days: RESEARCH_MEETING_WINDOW_DAYS,
      candidate_cells: topCells.length,
      pending_conjectures: knownConjectureKeys.size,
    },
    // Run anchor/provenance only; keep the event but skip Mem0 + brief regeneration.
    ingest_at: now,
    created_at: now,
  });

  // ── LLM half: independent top cells run in parallel; each cell remains swallow-safe ──
  const cellResults = await Promise.all(
    topCells.map(async (cell): Promise<{ created: number; cost_usd: number }> => {
      let incurredCostUsd = 0;
      try {
        const induced = await induceConjectureFn({
          cells: [cell],
          samples: RESEARCH_MEETING_SAMPLES,
          runTaskFn,
        });
        // Count the Opus induction spend immediately — it was incurred regardless of
        // whether the proposal write below succeeds (OCR: don't lose cost on a write throw).
        incurredCostUsd = induced.cost_usd;
        await writeAiProposalFn(db, buildConjectureProposalInput(cell, induced, triggerEventId));
        return { created: 1, cost_usd: incurredCostUsd };
      } catch (err) {
        console.error('[research_meeting_nightly] conjecture cell failed', cell.key, err);
        await writeRetryableAiFailureLedgerFn(db, 'MindModelInductionTask');
        return { created: 0, cost_usd: incurredCostUsd };
      }
    }),
  );
  const created = cellResults.reduce((sum, result) => sum + result.created, 0);
  const costUsd = cellResults.reduce((sum, result) => sum + result.cost_usd, 0);

  // Observability scan event — NOT cost-bearing: each conjecture proposal event already
  // carries its own cost_micro_usd via writeAiProposal, so summing the run total here would
  // DOUBLE-COUNT the AI spend in the cost ribbon (OCR review). The per-run total is still
  // surfaced via the return value (cost_usd) for the job log.
  await writeEventFn(db, {
    id: `research_meeting_scan_${newId()}`,
    actor_kind: 'agent',
    actor_ref: RESEARCH_MEETING_ACTOR,
    action: 'experimental:research_meeting_scan',
    subject_kind: 'query',
    subject_id: triggerEventId,
    outcome: 'success',
    payload: {
      considered: topCells.length,
      conjectures_created: created,
      pending_before: knownConjectureKeys.size,
    },
    caused_by_event_id: triggerEventId,
    cost_micro_usd: null,
    // Aggregate observability only; not evidence about the learner.
    ingest_at: now,
    created_at: now,
  });

  return {
    considered: topCells.length,
    conjectures_created: created,
    pending_before: knownConjectureKeys.size,
    reconciled: reconcileResult.reconciled,
    reconcile_skipped: reconcileResult.skipped,
    cost_usd: costUsd,
    trigger_event_id: triggerEventId,
  };
}

export function buildResearchMeetingNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runResearchMeetingNightly(db);
      console.log('[research_meeting_nightly] result', result);
    } catch (err) {
      console.error('[research_meeting_nightly] failed', err);
      throw err;
    }
  };
}
