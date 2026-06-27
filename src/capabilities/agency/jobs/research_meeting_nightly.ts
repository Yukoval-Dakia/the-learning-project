// YUK-406 Phase 0 (关系脑 thin slice) / YUK-440 (A13) — nightly 教研例会
// (research-meeting) propose handler.
//
// Structurally a clone of goal_scope_propose_nightly.ts: a thin candidate-picker +
// dedup gate + a SEQUENTIAL producer loop (NOT an MCP tool-agent loop). The job is
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

import type { Job } from 'pg-boss';

import { writeRetryableAiFailureLedger } from '@/capabilities/knowledge/server/ai_failure_log';
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { conjectureKey, gatherConjectureEvidence } from '@/server/conjectures/evidence';
import type { EvidenceCell } from '@/server/conjectures/evidence';
import {
  type FailureAttempt,
  type WriteEventInput,
  getFailureAttempts,
  writeEvent,
} from '@/server/events/queries';
import { getMasteryProjection } from '@/server/mastery/state';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { type WriteAiProposalInput, writeAiProposal } from '@/server/proposals/writer';

import { type InduceConjectureResult, induceConjecture } from '@/server/agency/conjecture/induce';

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
  /** total Opus cost across the run's inductions, USD. */
  cost_usd: number;
  /** the run's anchor event id (provenance + scan subject). */
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
  return async (kind, input, ctx) => {
    const { runTask } = await import('@/server/ai/runner');
    return runTask(kind, input, {
      ...(ctx as Record<string, unknown>),
      db,
    } as Parameters<typeof runTask>[2]);
  };
}

/** Assemble the propose-only conjecture payload (deterministic cell facts + LLM draft). */
function buildConjectureProposalInput(
  cell: EvidenceCell,
  induced: InduceConjectureResult,
  triggerEventId: string,
): WriteAiProposalInput {
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
        discriminating: induced.draft.discriminating,
        corrected_by_owner: false,
        // A13 (YUK-440): the falsifiable bet + the number it must later beat.
        predicted_p: induced.draft.predicted_p,
        baseline_p_at_induction: cell.baseline_p ?? 0.5, // 0.5 = cold-start neutral
      },
      cooldown_key: `conjecture:${cell.key}`,
    },
    caused_by_event_id: triggerEventId,
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

  // ── PRE-LLM reads (OUTSIDE the per-cell swallow — a throw here is retryable) ──
  const since = new Date(now.getTime() - RESEARCH_MEETING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const failures: FailureAttempt[] = await getFailureAttemptsFn(db, { since });
  const kcIds = [...new Set(failures.flatMap((f) => f.referenced_knowledge_ids))];
  const masteryByKnowledgeId =
    kcIds.length > 0 ? await getMasteryProjectionFn(db, kcIds) : new Map();
  const knownConjectureKeys = await loadKnownConjectureKeysFn(db);

  // ── Deterministic 取证 + top-K salience cap ──
  const cells = gatherConjectureEvidence({ failures, masteryByKnowledgeId, knownConjectureKeys });
  const topCells = cells.slice(0, RESEARCH_MEETING_MAX_CONJECTURES);

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
    created_at: now,
  });

  // ── LLM half: one conjecture per top cell (per-cell swallow → partial progress) ──
  let created = 0;
  let costUsd = 0;
  for (const cell of topCells) {
    try {
      const induced = await induceConjectureFn({
        cells: [cell],
        samples: RESEARCH_MEETING_SAMPLES,
        runTaskFn,
      });
      // Count the Opus induction spend immediately — it was incurred regardless of
      // whether the proposal write below succeeds (OCR: don't lose cost on a write throw).
      costUsd += induced.cost_usd;
      await writeAiProposalFn(db, buildConjectureProposalInput(cell, induced, triggerEventId));
      created += 1;
    } catch (err) {
      console.error('[research_meeting_nightly] conjecture cell failed', cell.key, err);
      await writeRetryableAiFailureLedgerFn(db, 'MindModelInductionTask');
    }
  }

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
    created_at: now,
  });

  return {
    considered: topCells.length,
    conjectures_created: created,
    pending_before: knownConjectureKeys.size,
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
