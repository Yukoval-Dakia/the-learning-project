// YUK-406 Phase 0 / YUK-440 A13 — research_meeting_nightly orchestration unit tests.
// Fully injected deps (no DB / AI). The REAL gatherConjectureEvidence runs over the
// injected failures, so this also locks the 取证 → top-K → propose integration.

import type {
  InduceConjectureInput,
  InduceConjectureResult,
} from '@/server/agency/conjecture/induce';
import { conjectureKey } from '@/server/conjectures/evidence';
import type { FailureAttempt, WriteEventInput } from '@/server/events/queries';
import type { MasteryProjection } from '@/server/mastery/state';
import type { WriteAiProposalInput } from '@/server/proposals/writer';
import { describe, expect, it, vi } from 'vitest';

import {
  RESEARCH_MEETING_MAX_CONJECTURES,
  type ResearchMeetingDeps,
  runResearchMeetingNightly,
} from './research_meeting_nightly';

function failure(id: string, kcIds: string[], category: string): FailureAttempt {
  const correction_state = {
    terminal_state: 'active',
    effective_event_id: id,
  } as FailureAttempt['correction_state'];
  return {
    attempt_event_id: id,
    question_id: `q_${id}`,
    answer_md: null,
    answer_image_refs: [],
    referenced_knowledge_ids: kcIds,
    created_at: new Date('2026-06-25T00:00:00Z'),
    correction_state,
    judge: {
      judge_event_id: `j_${id}`,
      cause: {
        primary_category: category,
        secondary_categories: [],
        analysis_md: 'agent analysis',
        confidence: 0.6,
      } as NonNullable<FailureAttempt['judge']>['cause'],
      referenced_knowledge_ids: kcIds,
      created_at: new Date('2026-06-25T00:00:00Z'),
      correction_state,
    },
  };
}

function projection(mastery: number): MasteryProjection {
  return {
    mastery,
    mastery_lo: Math.max(0, mastery - 0.1),
    mastery_hi: Math.min(1, mastery + 0.1),
    low_confidence: true,
    theta_hat: -0.3,
    theta_precision: 1.0,
    theta_se: 1.0,
    beta: 0, // YUK-495 #41 — KC difficulty anchor (effectiveB); neutral in this mastery mock
    evidence_count: 3,
    success_count: 1,
    fail_count: 2,
    last_outcome_at: new Date('2026-06-25T00:00:00Z'),
  };
}

function fakeInduced(input: InduceConjectureInput): InduceConjectureResult {
  const cell = input.cells[0];
  return {
    draft: {
      claim_md: `你混淆 ${cell.knowledge_id}`,
      probe_md: `probe for ${cell.knowledge_id}`,
      cause_category: cell.cause_category,
      recurrence_count: cell.recurrence_count,
      predicted_p: 0.3,
      discriminating: true,
      agreement_count: 2,
    },
    confidence: 0.66,
    confidence_capped: false,
    samples: input.samples,
    task_run_ids: [`tr_${cell.knowledge_id}`],
    cost_usd: 0.02,
  };
}

/** Two failures per KC so each (category × KC) cell clears the recurrence floor. */
function failuresForKcs(kcs: string[], category = 'concept_confusion'): FailureAttempt[] {
  return kcs.flatMap((kc, i) => [
    failure(`a_${kc}_${i}`, [kc], category),
    failure(`b_${kc}_${i}`, [kc], category),
  ]);
}

function baseDeps(overrides: Partial<ResearchMeetingDeps> = {}): ResearchMeetingDeps {
  return {
    now: () => new Date('2026-06-26T20:00:00Z'),
    getFailureAttemptsFn: vi.fn(async () => failuresForKcs(['k_a', 'k_b'])),
    getMasteryProjectionFn: vi.fn(async () => new Map<string, MasteryProjection>()),
    loadKnownConjectureKeysFn: vi.fn(async () => new Set<string>()),
    induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => fakeInduced(input)),
    writeAiProposalFn: vi.fn(async () => 'prop_1'),
    writeEventFn: vi.fn(async (_db, input) => input.id),
    writeRetryableAiFailureLedgerFn: vi.fn(async () => {}),
    // U8: stub the reconcile loop so unit tests never touch the DB (the real default
    // reads probe_result events). Wiring is asserted in its own test below.
    reconcileFn: vi.fn(async () => ({ reconciled: 0, skipped: 0 })),
    ...overrides,
  };
}

describe('runResearchMeetingNightly', () => {
  it('proposes one conjecture per top cell and writes a cost-bearing scan event', async () => {
    const writeAiProposalFn = vi.fn(async () => 'prop_x');
    const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => input.id);
    const deps = baseDeps({ writeAiProposalFn, writeEventFn });

    const result = await runResearchMeetingNightly({} as never, deps);

    expect(result.considered).toBe(2);
    expect(result.conjectures_created).toBe(2);
    expect(result.cost_usd).toBeCloseTo(0.04, 6); // 2 × 0.02
    expect(writeAiProposalFn).toHaveBeenCalledTimes(2);
    // trigger + scan events.
    const actions = writeEventFn.mock.calls.map((c) => c[1].action);
    expect(actions).toContain('experimental:trigger_research_meeting');
    expect(actions).toContain('experimental:research_meeting_scan');
  });

  it('caps proposals at the top-K salient cells', async () => {
    const writeAiProposalFn = vi.fn(async () => 'prop_x');
    const deps = baseDeps({
      // 5 distinct KCs → 5 cells, but only RESEARCH_MEETING_MAX_CONJECTURES proposed.
      getFailureAttemptsFn: vi.fn(async () => failuresForKcs(['k_a', 'k_b', 'k_c', 'k_d', 'k_e'])),
      writeAiProposalFn,
    });

    const result = await runResearchMeetingNightly({} as never, deps);
    expect(result.considered).toBe(RESEARCH_MEETING_MAX_CONJECTURES);
    expect(writeAiProposalFn).toHaveBeenCalledTimes(RESEARCH_MEETING_MAX_CONJECTURES);
  });

  it('builds a propose-only mind_model payload: provenance refs + A13 snapshot + internal confidence', async () => {
    const captured: WriteAiProposalInput[] = [];
    const writeAiProposalFn = vi.fn(async (_db: unknown, input: WriteAiProposalInput) => {
      captured.push(input);
      return 'prop_x';
    });
    const deps = baseDeps({
      getFailureAttemptsFn: vi.fn(async () => failuresForKcs(['k_a'])),
      getMasteryProjectionFn: vi.fn(
        async () => new Map<string, MasteryProjection>([['k_a', projection(0.42)]]),
      ),
      writeAiProposalFn,
    });

    const result = await runResearchMeetingNightly({} as never, deps);
    expect(captured).toHaveLength(1);
    const input = captured[0];
    expect(input.actor_ref).toBe('research_meeting');
    expect(input.caused_by_event_id).toBe(result.trigger_event_id);
    expect(input.payload.kind).toBe('conjecture');
    if (input.payload.kind !== 'conjecture') throw new Error('kind narrowing');
    expect(input.payload.target.subject_kind).toBe('mind_model');
    expect(input.payload.target.subject_id).toBe('k_a');
    // provenance reuses the attempt event ids (deduped, ordered).
    expect(input.payload.evidence_refs).toEqual([
      { kind: 'event', id: 'a_k_a_0' },
      { kind: 'event', id: 'b_k_a_0' },
    ]);
    const change = input.payload.proposed_change;
    expect(change.knowledge_id).toBe('k_a');
    expect(change.recurrence_count).toBe(2);
    expect(change.confidence).toBe(0.66); // internal sort only (read model strips it)
    expect(change.predicted_p).toBe(0.3);
    expect(change.baseline_p_at_induction).toBe(0.42); // snapshot of mastery p(L)
    expect(change.corrected_by_owner).toBe(false);
    expect(change.discriminating).toBe(true);
  });

  it('snapshots baseline_p_at_induction to the cold-start neutral 0.5 when no mastery row', async () => {
    const captured: WriteAiProposalInput[] = [];
    const deps = baseDeps({
      getFailureAttemptsFn: vi.fn(async () => failuresForKcs(['k_cold'])),
      getMasteryProjectionFn: vi.fn(async () => new Map<string, MasteryProjection>()),
      writeAiProposalFn: vi.fn(async (_db: unknown, input: WriteAiProposalInput) => {
        captured.push(input);
        return 'prop_x';
      }),
    });
    await runResearchMeetingNightly({} as never, deps);
    const change = captured[0].payload.proposed_change;
    if (captured[0].payload.kind !== 'conjecture') throw new Error('kind narrowing');
    expect(change).toMatchObject({ baseline_p_at_induction: 0.5 });
  });

  it('dedups: a cause×KC with a pending conjecture is not re-proposed', async () => {
    const writeAiProposalFn = vi.fn(async () => 'prop_x');
    const deps = baseDeps({
      getFailureAttemptsFn: vi.fn(async () => failuresForKcs(['k_a', 'k_b'])),
      loadKnownConjectureKeysFn: vi.fn(
        async () => new Set([conjectureKey('concept_confusion', 'k_a')]),
      ),
      writeAiProposalFn,
    });
    const result = await runResearchMeetingNightly({} as never, deps);
    expect(result.pending_before).toBe(1);
    expect(result.considered).toBe(1); // k_a deduped, only k_b survives
    expect(writeAiProposalFn).toHaveBeenCalledTimes(1);
  });

  it('swallows a single cell induction failure and continues (partial progress + ledger)', async () => {
    const writeAiProposalFn = vi.fn(async () => 'prop_x');
    const writeRetryableAiFailureLedgerFn = vi.fn(async () => {});
    let call = 0;
    const deps = baseDeps({
      getFailureAttemptsFn: vi.fn(async () => failuresForKcs(['k_a', 'k_b'])),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        call += 1;
        if (call === 1) throw new Error('opus lane blew up');
        return fakeInduced(input);
      }),
      writeAiProposalFn,
      writeRetryableAiFailureLedgerFn,
    });
    const result = await runResearchMeetingNightly({} as never, deps);
    expect(result.considered).toBe(2);
    expect(result.conjectures_created).toBe(1); // one failed, one succeeded
    expect(writeAiProposalFn).toHaveBeenCalledTimes(1);
    expect(writeRetryableAiFailureLedgerFn).toHaveBeenCalledTimes(1);
  });

  it('proposes nothing when there is no recurring evidence (no failures)', async () => {
    const writeAiProposalFn = vi.fn(async () => 'prop_x');
    const deps = baseDeps({
      getFailureAttemptsFn: vi.fn(async () => []),
      writeAiProposalFn,
    });
    const result = await runResearchMeetingNightly({} as never, deps);
    expect(result.considered).toBe(0);
    expect(result.conjectures_created).toBe(0);
    expect(writeAiProposalFn).not.toHaveBeenCalled();
  });

  it('runs the A13 reconcile loop and surfaces the reconciled count (U8)', async () => {
    const reconcileFn = vi.fn(async () => ({ reconciled: 2, skipped: 1 }));
    // No failures → empty propose half, isolating the reconcile wiring assertion.
    const deps = baseDeps({ reconcileFn, getFailureAttemptsFn: vi.fn(async () => []) });
    const result = await runResearchMeetingNightly({} as never, deps);
    expect(reconcileFn).toHaveBeenCalledTimes(1);
    expect(result.reconciled).toBe(2);
    expect(result.reconcile_skipped).toBe(1);
  });
});
