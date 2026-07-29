// YUK-406 Phase 0 / YUK-440 A13 — research_meeting_nightly orchestration unit tests.
// Fully injected deps (no DB / AI). The REAL gatherConjectureEvidence runs over the
// injected failures, so this also locks the 取证 → top-K → propose integration.

import { conjectureKey } from '@/capabilities/agency/server/conjecture/evidence';
import type {
  ConjectureEvidenceAssetRef,
  ConjectureFailureAttempt,
  EnrichedEvidenceCell,
  EvidenceCell,
  LoadedConjectureEvidenceImage,
} from '@/capabilities/agency/server/conjecture/evidence';
import type { WriteEventInput } from '@/kernel/events';
import {
  ConjectureInductionOperationalError,
  type InduceConjectureInput,
  type InduceConjectureResult,
} from '@/server/agency/conjecture/induce';
import { classifyJobYield } from '@/server/boss/job-yield';
import type { PredictionAccountability } from '@/server/conjectures/accountability';
import type { FailureAttempt, FailureAttemptWithReasoningTrace } from '@/server/events/queries';
import type { MasteryProjection } from '@/server/mastery/state';
import type { WriteAiProposalInput } from '@/server/proposals/writer';
import { resolveSubjectProfile } from '@/subjects/profile';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import {
  RESEARCH_MEETING_MAX_CONJECTURES,
  RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL,
  RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL,
  type ResearchMeetingDeps,
  type ResearchMeetingResult,
  buildResearchMeetingNightlyHandler,
  defaultLoadEvidenceImages,
  planConjectureEvidenceImageLoad,
  runResearchMeetingNightly,
} from './research_meeting_nightly';

const NOW = new Date('2026-06-26T20:00:00Z');

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
    provenance: 'observed', // YUK-559 (S1) — mock is an observed KC row
  };
}

function fakeInduced(input: InduceConjectureInput): InduceConjectureResult {
  const cell = input.cells[0];
  return {
    outcome: 'proposal',
    draft: {
      kind: 'proposal',
      claim_md: `你混淆 ${cell.knowledge_id}`,
      knowledge_id: cell.knowledge_id,
      evidence_event_ids: cell.evidence_event_ids,
      diagnostic_spec: {
        schema_version: 1,
        target_error_rule_md: `错误应用 ${cell.knowledge_id} 的规则`,
        trigger_conditions_md: `题目要求使用 ${cell.knowledge_id}`,
        scope_boundary_md: '不推断其它知识点。',
        expected_wrong_answer_signature_md: '答案呈现目标错误规则。',
      },
      probe_md: `probe for ${cell.knowledge_id}`,
      probe_reference_md: `reference answer for ${cell.knowledge_id}`,
      followup_probe_md: `follow-up probe for ${cell.knowledge_id}`,
      followup_probe_reference_md: `follow-up reference answer for ${cell.knowledge_id}`,
      probe_spec: {
        prompt_md: `probe for ${cell.knowledge_id}`,
        reference_md: `reference answer for ${cell.knowledge_id}`,
        expected_target_error_answer_md: `target error answer for ${cell.knowledge_id}`,
        elicits_target_error_reason_md: 'primary trigger',
        context_kind: 'abstract',
        representation_kind: 'symbolic',
      },
      followup_probe_spec: {
        prompt_md: `follow-up probe for ${cell.knowledge_id}`,
        reference_md: `follow-up reference answer for ${cell.knowledge_id}`,
        expected_target_error_answer_md: `follow-up target error answer for ${cell.knowledge_id}`,
        elicits_target_error_reason_md: 'follow-up trigger',
        context_kind: 'applied',
        representation_kind: 'natural_language',
      },
      probe_quality: {
        schema_version: 1,
        passed: true,
        attempts: [
          {
            attempt: 1,
            outcome: 'passed',
            failure_codes: [],
            explanation_md: 'verified',
            author_task_run_id: `tr_${cell.knowledge_id}_author`,
            reviewer_task_run_id: `tr_${cell.knowledge_id}_review`,
          },
        ],
        final_review: {
          verdict: 'pass',
          failure_codes: [],
          explanation_md: 'verified',
        },
      },
      cause_category: cell.cause_category,
      recurrence_count: cell.recurrence_count,
      predicted_p: 0.3,
      discriminating: true,
      agreement_count: 2,
    },
    confidence: 0.66,
    confidence_capped: false,
    samples: input.samples,
    primary_task_run_id: `tr_${cell.knowledge_id}_author`,
    task_run_ids: [
      `tr_${cell.knowledge_id}_1`,
      `tr_${cell.knowledge_id}_2`,
      `tr_${cell.knowledge_id}_3`,
      `tr_${cell.knowledge_id}_author`,
      `tr_${cell.knowledge_id}_review`,
    ],
    cost_usd: 0.02,
    votes: { proposal: 2, abstain: 0, invalid: 0, failed: 1 },
    probe_quality_attempts: [
      {
        attempt: 1,
        outcome: 'passed',
        failure_codes: [],
        explanation_md: 'verified',
        author_task_run_id: `tr_${cell.knowledge_id}_author`,
        reviewer_task_run_id: `tr_${cell.knowledge_id}_review`,
      },
    ],
  };
}

function fakeAbstained(input: InduceConjectureInput): InduceConjectureResult {
  return {
    outcome: 'abstain',
    draft: {
      kind: 'abstain',
      reason_code: 'insufficient_evidence',
      explanation_md: '两次错答没有形成稳定的共同模式。',
      evidence_event_ids: [input.cells[0].evidence_event_ids[0]],
    },
    confidence: 0,
    confidence_capped: false,
    samples: input.samples,
    task_run_ids: ['tr_abstain_1', 'tr_abstain_2', 'tr_abstain_3'],
    cost_usd: 0.015,
    votes: { proposal: 0, abstain: 3, invalid: 0, failed: 0 },
    probe_quality_attempts: [],
  };
}

/** Two failures per KC so each (category × KC) cell clears the recurrence floor. */
function failuresForKcs(kcs: string[], category = 'concept_confusion'): FailureAttempt[] {
  return kcs.flatMap((kc, i) => [
    failure(`a_${kc}_${i}`, [kc], category),
    failure(`b_${kc}_${i}`, [kc], category),
  ]);
}

/**
 * YUK-786 — the job now reads through the trace-bearing LIST reader, so the
 * fixtures ride in that wrapper shape. `reasoning_trace` is derived per attempt
 * so the assertions below can prove the job routes it into the enrich step.
 */
function withTraces(failures: FailureAttempt[]): FailureAttemptWithReasoningTrace[] {
  return failures.map((f) => ({
    failure: f,
    reasoning_trace: `trace of ${f.attempt_event_id}`,
  }));
}

/**
 * YUK-786 — stand-in for the PRE-LLM grounding read (the real one hits the DB).
 * Echoes the cell fields the enrich step would resolve so the job's pass-through
 * is observable without a container.
 */
function fakeEnrich(
  _db: unknown,
  input: {
    cells: EvidenceCell[];
    failures: ConjectureFailureAttempt[];
    reasoningTraceByAttemptId?: ReadonlyMap<string, string | null>;
  },
): Promise<EnrichedEvidenceCell[]> {
  return Promise.resolve(
    input.cells.map((cell) => ({
      ...cell,
      knowledge_name: `name of ${cell.knowledge_id}`,
      subject_id: 'yuwen',
      subject_display_name: '语文',
      samples: cell.evidence_event_ids.map((attemptId) => ({
        attempt_event_id: attemptId,
        question_id: `q_${attemptId}`,
        question_prompt_md: `<untrusted_learner_text>prompt of ${attemptId}</untrusted_learner_text>`,
        question_reference_md: `<untrusted_learner_text>reference of ${attemptId}</untrusted_learner_text>`,
        question_choices_md: null,
        question_image_refs: [],
        question_figures: [],
        parent_question_id: null,
        parent_question_prompt_md: null,
        parent_question_reference_md: null,
        parent_question_choices_md: null,
        parent_question_image_refs: [],
        parent_question_figures: [],
        answer_md: null,
        answer_image_refs: [],
        reasoning_trace: input.reasoningTraceByAttemptId?.get(attemptId) ?? null,
        cause_category: cell.cause_category,
        cause_source: 'agent',
        cause_attribution_md: 'agent analysis',
      })),
    })),
  );
}

function fakeLoadedImages(
  refs: readonly ConjectureEvidenceAssetRef[],
): LoadedConjectureEvidenceImage[] {
  return [...new Set(refs.map((ref) => ref.asset_id))].map((assetId) => ({
    asset_id: assetId,
    occurrences: refs
      .filter((ref) => ref.asset_id === assetId)
      .map(({ attempt_event_id, source }) => ({ attempt_event_id, source })),
    data: `BASE64_${assetId}`,
    mediaType: 'image/png',
  }));
}

function baseDeps(overrides: Partial<ResearchMeetingDeps> = {}): ResearchMeetingDeps {
  return {
    now: () => NOW,
    enrichEvidenceCellsFn: vi.fn(fakeEnrich),
    getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a', 'k_b']))),
    getMasteryProjectionFn: vi.fn(async () => new Map<string, MasteryProjection>()),
    loadKnownConjectureKeysFn: vi.fn(async () => new Set<string>()),
    loadConjectureHistoryFn: vi.fn(async () => new Map()),
    loadPredictionAccountabilityFn: vi.fn(async () => new Map()),
    induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => fakeInduced(input)),
    writeAiProposalFn: vi.fn(async () => 'prop_1'),
    writeEventFn: vi.fn(async (_db, input) => input.id),
    runInTransactionFn: vi.fn(async (db, fn) => fn(db)),
    runWithExecutionLockFn: vi.fn(async (_db, _executionId, fn) => fn()),
    loadCompletedRunResultFn: vi.fn(async () => null),
    loadReconciliationResultFn: vi.fn(async () => null),
    countReconciledForExecutionFn: vi.fn(async () => 0),
    writeRetryableAiFailureLedgerFn: vi.fn(async () => {}),
    // U8: stub the reconcile loop so unit tests never touch the DB (the real default
    // reads probe_result events). Wiring is asserted in its own test below.
    reconcileFn: vi.fn(async () => ({ reconciled: 0, skipped: 0 })),
    ...overrides,
  };
}

describe('runResearchMeetingNightly', () => {
  it('returns a committed completion summary on pg-boss redelivery without repeating work', async () => {
    const completed: ResearchMeetingResult = {
      considered: 2,
      conjectures_created: 1,
      conjectures_abstained: 1,
      cells_failed: 0,
      pending_before: 0,
      reconciled: 0,
      reconcile_skipped: 0,
      cost_usd: 0.035,
      trigger_event_id: 'research_meeting_trigger_committed',
    };
    const getFailureAttemptsWithTraceFn = vi.fn(async () => withTraces(failuresForKcs(['k_a'])));
    const induceConjectureFn = vi.fn(async (input: InduceConjectureInput) => fakeInduced(input));
    const reconcileFn = vi.fn(async () => ({ reconciled: 0, skipped: 0 }));

    const result = await runResearchMeetingNightly(
      {} as never,
      baseDeps({
        executionId: 'job_already_committed',
        loadCompletedRunResultFn: vi.fn(async () => completed),
        getFailureAttemptsWithTraceFn,
        induceConjectureFn,
        reconcileFn,
      }),
    );

    expect(result).toEqual(completed);
    expect(reconcileFn).not.toHaveBeenCalled();
    expect(getFailureAttemptsWithTraceFn).not.toHaveBeenCalled();
    expect(induceConjectureFn).not.toHaveBeenCalled();
  });

  it('proposes one conjecture per top cell and opts run bookkeeping out of memory', async () => {
    const writeAiProposalFn = vi.fn(async () => 'prop_x');
    const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => input.id);
    const deps = baseDeps({ writeAiProposalFn, writeEventFn });

    const result = await runResearchMeetingNightly({} as never, deps);

    expect(result.considered).toBe(2);
    expect(result.conjectures_created).toBe(2);
    expect(result.cost_usd).toBeCloseTo(0.04, 6); // 2 × 0.02
    expect(writeAiProposalFn).toHaveBeenCalledTimes(2);
    // trigger + scan + durable completion guard.
    const actions = writeEventFn.mock.calls.map((c) => c[1].action);
    expect(actions).toContain('experimental:trigger_research_meeting');
    expect(actions).toContain('experimental:research_meeting_scan');
    expect(actions).toContain('experimental:research_meeting_completed');
    // All three rows are internal run bookkeeping: persisted for provenance/admin
    // reads, born opted out of Mem0 and brief regeneration.
    expect(writeEventFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'experimental:trigger_research_meeting',
        ingest_at: NOW,
      }),
    );
    expect(writeEventFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'experimental:research_meeting_scan',
        ingest_at: NOW,
      }),
    );
  });

  it('persists trigger, cell outcomes, scan, and completion through one transaction scope', async () => {
    const tx = { kind: 'test-transaction' } as never;
    const writeAiProposalFn = vi.fn(async () => 'prop_x');
    const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => input.id);
    const runInTransactionFn = vi.fn(async (_db: unknown, fn: (scope: never) => Promise<void>) =>
      fn(tx),
    );
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a']))),
      writeAiProposalFn,
      writeEventFn,
      runInTransactionFn,
    });

    await runResearchMeetingNightly({} as never, deps);

    expect(runInTransactionFn).toHaveBeenCalledTimes(1);
    expect(writeAiProposalFn).toHaveBeenCalledWith(tx, expect.anything());
    expect(writeEventFn).toHaveBeenCalledTimes(4);
    const finalTransactionCalls = writeEventFn.mock.calls.filter(
      ([, input]) => input.action !== 'experimental:research_meeting_reconciled',
    );
    expect(finalTransactionCalls).toHaveLength(3);
    expect(finalTransactionCalls.every(([scope]) => scope === tx)).toBe(true);
  });

  it('caps proposals at the top-K salient cells', async () => {
    const writeAiProposalFn = vi.fn(async () => 'prop_x');
    const deps = baseDeps({
      // 5 distinct KCs → 5 cells, but only RESEARCH_MEETING_MAX_CONJECTURES proposed.
      getFailureAttemptsWithTraceFn: vi.fn(async () =>
        withTraces(failuresForKcs(['k_a', 'k_b', 'k_c', 'k_d', 'k_e'])),
      ),
      writeAiProposalFn,
    });

    const result = await runResearchMeetingNightly({} as never, deps);
    expect(result.considered).toBe(RESEARCH_MEETING_MAX_CONJECTURES);
    expect(writeAiProposalFn).toHaveBeenCalledTimes(RESEARCH_MEETING_MAX_CONJECTURES);
  });

  it('applies prediction accountability before the top-K cut', async () => {
    const inducedKnowledgeIds: string[] = [];
    const downweightedKey = conjectureKey('concept_confusion', 'k_a');
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () =>
        withTraces(failuresForKcs(['k_a', 'k_b', 'k_c', 'k_d'])),
      ),
      loadPredictionAccountabilityFn: vi.fn(
        async () =>
          new Map<string, PredictionAccountability>([
            [
              downweightedKey,
              {
                state: 'downweighted',
                latest_direction: 'miss',
                consecutive_count: 2,
                rank_multiplier: 0.25,
                hard_confirm_verdict: 'INSUFFICIENT',
                hard_confirm_enabled: false,
                score_event_ids: ['score_1', 'score_2'],
              },
            ],
          ]),
      ),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        inducedKnowledgeIds.push(input.cells[0].knowledge_id);
        return fakeInduced(input);
      }),
    });

    await runResearchMeetingNightly({} as never, deps);

    expect(inducedKnowledgeIds).toEqual(['k_b', 'k_c', 'k_d']);
    expect(inducedKnowledgeIds).not.toContain('k_a');
  });

  it('re-applies accountability after enrichment validates the recurrence count', async () => {
    const inducedKnowledgeIds: string[] = [];
    const downweightedKey = conjectureKey('concept_confusion', 'k_a');
    const rawFailures = [
      ...Array.from({ length: 12 }, (_, index) =>
        failure(`a_raw_${index}`, ['k_a'], 'concept_confusion'),
      ),
      ...['k_b', 'k_c', 'k_d'].flatMap((knowledgeId) =>
        Array.from({ length: 3 }, (_, index) =>
          failure(`${knowledgeId}_raw_${index}`, [knowledgeId], 'concept_confusion'),
        ),
      ),
    ];
    const enrichEvidenceCellsFn = vi.fn(async (db, input) =>
      (await fakeEnrich(db, input)).map((cell) =>
        cell.knowledge_id === 'k_a'
          ? {
              ...cell,
              samples: cell.samples.slice(0, 2),
              evidence_event_ids: cell.evidence_event_ids.slice(0, 2),
              recurrence_count: 2,
            }
          : cell,
      ),
    );
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(rawFailures)),
      enrichEvidenceCellsFn,
      loadPredictionAccountabilityFn: vi.fn(
        async () =>
          new Map<string, PredictionAccountability>([
            [
              downweightedKey,
              {
                state: 'downweighted',
                latest_direction: 'miss',
                consecutive_count: 2,
                rank_multiplier: 0.25,
                hard_confirm_verdict: 'INSUFFICIENT',
                hard_confirm_enabled: false,
                score_event_ids: ['score_1', 'score_2'],
              },
            ],
          ]),
      ),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        inducedKnowledgeIds.push(input.cells[0].knowledge_id);
        return fakeInduced(input);
      }),
    });

    await runResearchMeetingNightly({} as never, deps);

    expect(enrichEvidenceCellsFn).toHaveBeenCalledTimes(2);
    expect(inducedKnowledgeIds).toEqual(['k_b', 'k_c', 'k_d']);
    expect(inducedKnowledgeIds).not.toContain('k_a');
  });

  it('builds a propose-only mind_model payload: provenance refs + A13 snapshot + internal confidence', async () => {
    const captured: WriteAiProposalInput[] = [];
    const writeAiProposalFn = vi.fn(async (_db: unknown, input: WriteAiProposalInput) => {
      captured.push(input);
      return 'prop_x';
    });
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a']))),
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
    expect(input.task_run_id).toBe('tr_k_a_author');
    expect(input.event_override?.payload).toEqual({
      induction_task_run_ids: [
        'tr_k_a_1',
        'tr_k_a_2',
        'tr_k_a_3',
        'tr_k_a_author',
        'tr_k_a_review',
      ],
      probe_quality_attempts: [
        {
          attempt: 1,
          outcome: 'passed',
          failure_codes: [],
          explanation_md: 'verified',
          author_task_run_id: 'tr_k_a_author',
          reviewer_task_run_id: 'tr_k_a_review',
        },
      ],
    });
  });

  it('persists only the winning sample evidence subset as proposal support', async () => {
    const captured: WriteAiProposalInput[] = [];
    const failureRows = [
      ...failuresForKcs(['k_a']),
      failure('c_k_a_0', ['k_a'], 'concept_confusion'),
    ];
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failureRows)),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        const induced = fakeInduced(input);
        if (induced.outcome !== 'proposal') throw new Error('expected proposal');
        return {
          ...induced,
          draft: {
            ...induced.draft,
            evidence_event_ids: input.cells[0].evidence_event_ids.slice(0, 2),
          },
        };
      }),
      writeAiProposalFn: vi.fn(async (_db: unknown, input: WriteAiProposalInput) => {
        captured.push(input);
        return 'prop_x';
      }),
    });

    await runResearchMeetingNightly({} as never, deps);

    expect(captured[0].payload.evidence_refs).toEqual([
      { kind: 'event', id: 'a_k_a_0' },
      { kind: 'event', id: 'b_k_a_0' },
    ]);
  });

  it('snapshots baseline_p_at_induction to the cold-start neutral 0.5 when no mastery row', async () => {
    const captured: WriteAiProposalInput[] = [];
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_cold']))),
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
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a', 'k_b']))),
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

  it('gates active/cooldown/terminal identities and passes owner prior on a valid reopen', async () => {
    const failures = failuresForKcs(['k_active', 'k_cooldown', 'k_settled', 'k_reopen']);
    const induceConjectureFn = vi.fn(async (input: InduceConjectureInput) => fakeInduced(input));
    const key = (knowledgeId: string) => conjectureKey('concept_confusion', knowledgeId);
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failures)),
      loadConjectureHistoryFn: vi.fn(async () => {
        const activeAt = new Date('2026-06-25T12:00:00Z');
        const terminalAt = new Date('2026-06-25T12:00:00Z');
        const reopenedTerminalAt = new Date('2026-06-24T00:00:00Z');
        return new Map([
          [
            key('k_active'),
            {
              latest_decision: 'accept' as const,
              latest_decision_at: activeAt,
              latest_accept_at: activeAt,
              latest_terminal_at: null,
              prior_claim_md: 'active claim',
            },
          ],
          [
            key('k_cooldown'),
            {
              latest_decision: 'dismiss' as const,
              latest_decision_at: new Date('2026-06-10T00:00:00Z'),
              latest_accept_at: null,
              latest_terminal_at: null,
              prior_claim_md: null,
            },
          ],
          [
            key('k_settled'),
            {
              latest_decision: 'accept' as const,
              latest_decision_at: new Date('2026-06-24T00:00:00Z'),
              latest_accept_at: new Date('2026-06-24T00:00:00Z'),
              latest_terminal_at: terminalAt,
              prior_claim_md: 'settled claim',
            },
          ],
          [
            key('k_reopen'),
            {
              latest_decision: 'accept' as const,
              latest_decision_at: new Date('2026-06-23T00:00:00Z'),
              latest_accept_at: new Date('2026-06-23T00:00:00Z'),
              latest_terminal_at: reopenedTerminalAt,
              prior_claim_md: 'owner corrected claim',
            },
          ],
        ]);
      }),
      induceConjectureFn,
    });

    const result = await runResearchMeetingNightly({} as never, deps);

    expect(result.considered).toBe(1);
    expect(induceConjectureFn).toHaveBeenCalledTimes(1);
    expect(induceConjectureFn.mock.calls[0][0]).toMatchObject({
      cells: [expect.objectContaining({ knowledge_id: 'k_reopen' })],
      priorClaimMd: 'owner corrected claim',
    });
  });

  it('revalidates the terminal reopen floor after enrichment removes fresh evidence', async () => {
    const oldA = failure('old_a', ['k_reopen'], 'concept_confusion');
    const oldB = failure('old_b', ['k_reopen'], 'concept_confusion');
    const freshA = failure('fresh_a', ['k_reopen'], 'concept_confusion');
    const freshB = failure('fresh_b', ['k_reopen'], 'concept_confusion');
    oldA.created_at = new Date('2026-06-23T00:00:00Z');
    oldB.created_at = new Date('2026-06-23T01:00:00Z');
    freshA.created_at = new Date('2026-06-25T00:00:00Z');
    freshB.created_at = new Date('2026-06-25T01:00:00Z');
    const failures = [oldA, oldB, freshA, freshB];
    const induceConjectureFn = vi.fn(async (input: InduceConjectureInput) => fakeInduced(input));
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failures)),
      loadConjectureHistoryFn: vi.fn(async () => {
        const acceptedAt = new Date('2026-06-22T00:00:00Z');
        return new Map([
          [
            conjectureKey('concept_confusion', 'k_reopen'),
            {
              latest_decision: 'accept' as const,
              latest_decision_at: acceptedAt,
              latest_accept_at: acceptedAt,
              latest_terminal_at: new Date('2026-06-24T00:00:00Z'),
              prior_claim_md: 'owner corrected claim',
            },
          ],
        ]);
      }),
      enrichEvidenceCellsFn: vi.fn(async (db, input) => {
        const enriched = await fakeEnrich(db, input);
        return enriched.map((cell) => ({
          ...cell,
          evidence_event_ids: ['old_a', 'old_b'],
          samples: cell.samples.filter((sample) =>
            ['old_a', 'old_b'].includes(sample.attempt_event_id),
          ),
        }));
      }),
      induceConjectureFn,
    });

    const result = await runResearchMeetingNightly({} as never, deps);

    expect(result.considered).toBe(0);
    expect(induceConjectureFn).not.toHaveBeenCalled();
  });

  it('persists abstain observability without proposal or retryable AI failure', async () => {
    const writeAiProposalFn = vi.fn(async () => 'unexpected');
    const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => input.id);
    const writeRetryableAiFailureLedgerFn = vi.fn(async () => {});
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a']))),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => fakeAbstained(input)),
      writeAiProposalFn,
      writeEventFn,
      writeRetryableAiFailureLedgerFn,
    });

    const result = await runResearchMeetingNightly({} as never, deps);

    expect(result).toMatchObject({
      considered: 1,
      conjectures_created: 0,
      conjectures_abstained: 1,
      cells_failed: 0,
      cost_usd: 0.015,
    });
    expect(writeAiProposalFn).not.toHaveBeenCalled();
    expect(writeRetryableAiFailureLedgerFn).not.toHaveBeenCalled();
    expect(writeEventFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'experimental:conjecture_abstained',
        outcome: 'partial',
        cost_micro_usd: 15_000,
        payload: expect.objectContaining({
          reason_code: 'insufficient_evidence',
          input_evidence_event_ids: ['a_k_a_0', 'b_k_a_0'],
          votes: { proposal: 0, abstain: 3, invalid: 0, failed: 0 },
        }),
      }),
    );
    expect(
      classifyJobYield({
        attempted: result.considered,
        succeeded: result.conjectures_created + result.conjectures_abstained,
        failed: result.cells_failed,
      }),
    ).toBe('ok');
  });

  it('classifies invalid-output abstention as a failed cell and stalls an all-bad night', async () => {
    const tx = { kind: 'operational-failure-transaction' } as never;
    const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => input.id);
    const writeRetryableAiFailureLedgerFn = vi.fn(async () => {});
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a']))),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        const induced = fakeAbstained(input);
        if (induced.outcome !== 'abstain') throw new Error('expected abstain fixture');
        return {
          ...induced,
          draft: { ...induced.draft, reason_code: 'invalid_output' as const },
          votes: { proposal: 0, abstain: 0, invalid: 3, failed: 0 },
        };
      }),
      writeEventFn,
      writeRetryableAiFailureLedgerFn,
      runInTransactionFn: vi.fn(async (_db, fn) => fn(tx)),
    });

    const result = await runResearchMeetingNightly({} as never, deps);

    expect(result).toMatchObject({
      considered: 1,
      conjectures_created: 0,
      conjectures_abstained: 0,
      cells_failed: 1,
    });
    expect(writeRetryableAiFailureLedgerFn).toHaveBeenCalledWith(tx, 'MindModelInductionTask', {
      throwOnError: true,
    });
    expect(writeEventFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'experimental:conjecture_abstained',
        outcome: 'failure',
        payload: expect.objectContaining({ reason_code: 'invalid_output' }),
      }),
    );
    expect(
      classifyJobYield({
        attempted: result.considered,
        succeeded: result.conjectures_created + result.conjectures_abstained,
        failed: result.cells_failed,
      }),
    ).toBe('stalled');
  });

  it('uses the uncollapsed vote ledger when mixed operational losses tie the display reason', async () => {
    const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => input.id);
    const writeRetryableAiFailureLedgerFn = vi.fn(async () => {});
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a']))),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        const induced = fakeAbstained(input);
        if (induced.outcome !== 'abstain') throw new Error('expected abstain fixture');
        return {
          ...induced,
          draft: { ...induced.draft, reason_code: 'no_semantic_consensus' as const },
          // The collapsed reasons tie 1:1:1. Two requested samples were still
          // operational losses, so this is not a healthy semantic disagreement.
          votes: { proposal: 1, abstain: 0, invalid: 1, failed: 1 },
        };
      }),
      writeEventFn,
      writeRetryableAiFailureLedgerFn,
    });

    const result = await runResearchMeetingNightly({} as never, deps);

    expect(result).toMatchObject({
      considered: 1,
      conjectures_created: 0,
      conjectures_abstained: 0,
      cells_failed: 1,
    });
    expect(writeRetryableAiFailureLedgerFn).toHaveBeenCalledTimes(1);
    expect(writeEventFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'experimental:conjecture_abstained',
        outcome: 'failure',
        payload: expect.objectContaining({
          reason_code: 'no_semantic_consensus',
          votes: { proposal: 1, abstain: 0, invalid: 1, failed: 1 },
        }),
      }),
    );
  });

  it('propagates the original transactional health-ledger error', async () => {
    const writeRetryableAiFailureLedgerFn = vi.fn(async () => {
      throw new Error('health ledger insert failed');
    });
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a']))),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        const induced = fakeAbstained(input);
        if (induced.outcome !== 'abstain') throw new Error('expected abstain fixture');
        return {
          ...induced,
          draft: { ...induced.draft, reason_code: 'invalid_output' as const },
          votes: { proposal: 0, abstain: 0, invalid: 3, failed: 0 },
        };
      }),
      writeRetryableAiFailureLedgerFn,
    });

    await expect(runResearchMeetingNightly({} as never, deps)).rejects.toThrow(
      'health ledger insert failed',
    );
    expect(writeRetryableAiFailureLedgerFn).toHaveBeenCalledWith(
      expect.anything(),
      'MindModelInductionTask',
      { throwOnError: true },
    );
  });

  it('reuses abstain event ids for one job retry but not for the next scheduled run', async () => {
    const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => input.id);
    const commonDeps = {
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a']))),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => fakeAbstained(input)),
      writeEventFn,
    };

    await runResearchMeetingNightly({} as never, baseDeps({ ...commonDeps, executionId: 'job_1' }));
    await runResearchMeetingNightly({} as never, baseDeps({ ...commonDeps, executionId: 'job_1' }));
    await runResearchMeetingNightly({} as never, baseDeps({ ...commonDeps, executionId: 'job_2' }));

    const abstainEventIds = writeEventFn.mock.calls
      .map((call) => call[1])
      .filter((input) => input.action === 'experimental:conjecture_abstained')
      .map((input) => input.id);
    expect(abstainEventIds).toHaveLength(3);
    expect(abstainEventIds[0]).toBe(abstainEventIds[1]);
    expect(abstainEventIds[2]).not.toBe(abstainEventIds[0]);

    for (const action of [
      'experimental:trigger_research_meeting',
      'experimental:research_meeting_scan',
      'experimental:research_meeting_completed',
    ]) {
      const ids = writeEventFn.mock.calls
        .map((call) => call[1])
        .filter((input) => input.action === action)
        .map((input) => input.id);
      expect(ids).toHaveLength(3);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[2]).not.toBe(ids[0]);
    }
  });

  it('reuses proposal ids for a concurrent/retried execution but not the next scheduled run', async () => {
    const writeAiProposalFn = vi.fn(
      async (_db: unknown, input: WriteAiProposalInput) => input.id ?? 'missing-proposal-id',
    );
    const commonDeps = {
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a']))),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => fakeInduced(input)),
      writeAiProposalFn,
    };

    await runResearchMeetingNightly({} as never, baseDeps({ ...commonDeps, executionId: 'job_1' }));
    await runResearchMeetingNightly({} as never, baseDeps({ ...commonDeps, executionId: 'job_1' }));
    await runResearchMeetingNightly({} as never, baseDeps({ ...commonDeps, executionId: 'job_2' }));

    const proposalIds = writeAiProposalFn.mock.calls.map((call) => call[1].id);
    expect(proposalIds).toHaveLength(3);
    expect(proposalIds[0]).toMatch(/^conjecture_proposal_/);
    expect(proposalIds[0]).toBe(proposalIds[1]);
    expect(proposalIds[2]).not.toBe(proposalIds[0]);
  });

  it('propagates an abstain event write failure without misclassifying it as an AI failure', async () => {
    const writeRetryableAiFailureLedgerFn = vi.fn(async () => {});
    const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => {
      if (input.action === 'experimental:conjecture_abstained') {
        throw new Error('database unavailable');
      }
      return input.id;
    });
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a']))),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => fakeAbstained(input)),
      writeEventFn,
      writeRetryableAiFailureLedgerFn,
    });

    await expect(runResearchMeetingNightly({} as never, deps)).rejects.toThrow(
      'database unavailable',
    );
    expect(writeRetryableAiFailureLedgerFn).not.toHaveBeenCalled();
  });

  it('swallows a single cell induction failure and continues (partial progress + ledger)', async () => {
    const writeAiProposalFn = vi.fn(async () => 'prop_x');
    const writeRetryableAiFailureLedgerFn = vi.fn(async () => {});
    let call = 0;
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a', 'k_b']))),
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
    expect(result.cells_failed).toBe(1); // YUK-779 — the swallow is now COUNTED
    expect(writeAiProposalFn).toHaveBeenCalledTimes(1);
    expect(writeRetryableAiFailureLedgerFn).toHaveBeenCalledTimes(1);
    // Partial progress is NOT an alarm: one of two cells landed, so the run still
    // advanced the state. (2 units is below YIELD_DEGRADED_MIN_SAMPLE anyway.)
    expect(
      classifyJobYield({
        attempted: result.considered,
        succeeded: result.conjectures_created,
        failed: result.cells_failed,
      }),
    ).toBe('ok');
  });

  it('attributes a load-bearing semantic-grouping failure to ConjectureGroupingTask', async () => {
    const tx = { kind: 'grouping-failure-transaction' } as never;
    const writeRetryableAiFailureLedgerFn = vi.fn(async () => {});
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a']))),
      induceConjectureFn: vi.fn(async () => {
        throw new ConjectureInductionOperationalError(
          'ConjectureGroupingTask',
          'semantic grouping output was malformed',
        );
      }),
      writeRetryableAiFailureLedgerFn,
      runInTransactionFn: vi.fn(async (_db, fn) => fn(tx)),
    });

    const result = await runResearchMeetingNightly({} as never, deps);

    expect(result).toMatchObject({
      considered: 1,
      conjectures_created: 0,
      conjectures_abstained: 0,
      cells_failed: 1,
    });
    expect(writeRetryableAiFailureLedgerFn).toHaveBeenCalledWith(tx, 'ConjectureGroupingTask', {
      throwOnError: true,
    });
  });

  it.each(['ConjectureProbeAuthorTask', 'ConjectureProbeReviewTask'] as const)(
    'propagates %s operational failures so pg-boss redelivers the unfinished execution',
    async (taskKind) => {
      const writeAiProposalFn = vi.fn(async () => 'unexpected');
      const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => input.id);
      const writeRetryableAiFailureLedgerFn = vi.fn(async () => {});
      const deps = baseDeps({
        getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a']))),
        induceConjectureFn: vi.fn(async () => {
          throw new ConjectureInductionOperationalError(taskKind, `${taskKind} output unavailable`);
        }),
        writeAiProposalFn,
        writeEventFn,
        writeRetryableAiFailureLedgerFn,
      });

      await expect(runResearchMeetingNightly({} as never, deps)).rejects.toThrow(
        `${taskKind} output unavailable`,
      );
      expect(writeRetryableAiFailureLedgerFn).toHaveBeenCalledWith(expect.anything(), taskKind);
      expect(writeAiProposalFn).not.toHaveBeenCalled();
      expect(writeEventFn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'experimental:research_meeting_completed',
        }),
      );
    },
  );

  // ── YUK-779: 静默空跑的红/绿实证 ───────────────────────────────────────────
  // 两侧必须同时成立才算修好：全败要报，空夜不能报。

  it('RED — 限流风暴（每一格 AI 调用都失败）→ 全部被吞、job 仍返回，但判为 stalled', async () => {
    const writeAiProposalFn = vi.fn(async () => 'prop_x');
    const writeRetryableAiFailureLedgerFn = vi.fn(async () => {});
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () =>
        withTraces(failuresForKcs(['k_a', 'k_b', 'k_c'])),
      ),
      // 429 风暴：同一批里每一格都失败。
      induceConjectureFn: vi.fn(async () => {
        throw new Error('429 rate_limit_error');
      }),
      writeAiProposalFn,
      writeRetryableAiFailureLedgerFn,
    });

    const result = await runResearchMeetingNightly({} as never, deps);

    // 刻意保留的吞错语义没变：run 正常返回，没有抛出（handler 仍会以 succeeded 收尾）。
    expect(result.considered).toBe(RESEARCH_MEETING_MAX_CONJECTURES);
    expect(result.conjectures_created).toBe(0);
    expect(result.cells_failed).toBe(RESEARCH_MEETING_MAX_CONJECTURES);
    expect(writeAiProposalFn).not.toHaveBeenCalled();
    expect(writeRetryableAiFailureLedgerFn).toHaveBeenCalledTimes(RESEARCH_MEETING_MAX_CONJECTURES);

    // ★ 判据命中：试过、且一个都没成 —— 这就是静默空跑。
    expect(
      classifyJobYield({
        attempted: result.considered,
        succeeded: result.conjectures_created,
        failed: result.cells_failed,
      }),
    ).toBe('stalled');
  });

  it('GREEN — 空夜（无 recurring evidence，压根没调 AI）→ 判为 idle，绝不报警', async () => {
    const induceConjectureFn = vi.fn(async (input: InduceConjectureInput) => fakeInduced(input));
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => []),
      induceConjectureFn,
    });

    const result = await runResearchMeetingNightly({} as never, deps);

    // 产出同样是 0 —— 但成因完全不同：一次 AI 调用都没发生。
    expect(induceConjectureFn).not.toHaveBeenCalled();
    expect(result.considered).toBe(0);
    expect(result.conjectures_created).toBe(0);
    expect(result.cells_failed).toBe(0);

    // ★ 这正是判据要保护的一侧：正常的零产出不得报警。
    expect(
      classifyJobYield({
        attempted: result.considered,
        succeeded: result.conjectures_created,
        failed: result.cells_failed,
      }),
    ).toBe('idle');
  });

  it('GREEN — 全部候选已有 pending conjecture（dedup 挡住）→ 同样是 idle', async () => {
    // 另一条「正常的零产出」路径：有失败证据，但每个 cell 都被 dedup 去掉了。
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a', 'k_b']))),
      loadKnownConjectureKeysFn: vi.fn(
        async () =>
          new Set([
            conjectureKey('concept_confusion', 'k_a'),
            conjectureKey('concept_confusion', 'k_b'),
          ]),
      ),
    });

    const result = await runResearchMeetingNightly({} as never, deps);
    expect(result.considered).toBe(0);
    expect(result.cells_failed).toBe(0);
    expect(
      classifyJobYield({
        attempted: result.considered,
        succeeded: result.conjectures_created,
        failed: result.cells_failed,
      }),
    ).toBe('idle');
  });

  it('induces independent top cells concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () =>
        withTraces(failuresForKcs(['k_a', 'k_b', 'k_c'])),
      ),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return fakeInduced(input);
      }),
    });

    const result = await runResearchMeetingNightly({} as never, deps);
    expect(result.conjectures_created).toBe(3);
    expect(maxInFlight).toBe(3);
  });

  it('proposes nothing when there is no recurring evidence (no failures)', async () => {
    const writeAiProposalFn = vi.fn(async () => 'prop_x');
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => []),
      writeAiProposalFn,
    });
    const result = await runResearchMeetingNightly({} as never, deps);
    expect(result.considered).toBe(0);
    expect(result.conjectures_created).toBe(0);
    expect(writeAiProposalFn).not.toHaveBeenCalled();
  });

  it('empty night persists only a completion guard after reconcile and runs zero LLM calls', async () => {
    const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => input.id);
    const induceConjectureFn = vi.fn(async (input: InduceConjectureInput) => fakeInduced(input));
    const reconcileFn = vi.fn(async () => ({ reconciled: 3, skipped: 0 }));
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => []),
      writeEventFn,
      induceConjectureFn,
      reconcileFn,
    });
    const result = await runResearchMeetingNightly({} as never, deps);
    // The deterministic reconcile half still ran (it must never be skipped)…
    expect(reconcileFn).toHaveBeenCalledTimes(1);
    expect(result.reconciled).toBe(3);
    // …but the propose half writes no anchor/scan. Reconcile checkpoint + completion
    // guard make a same-job redelivery a no-op even if new evidence appears meanwhile.
    expect(writeEventFn).toHaveBeenCalledTimes(2);
    expect(writeEventFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'experimental:research_meeting_reconciled',
        payload: expect.objectContaining({
          reconcile_result: { reconciled: 3, skipped: 0 },
        }),
      }),
    );
    expect(writeEventFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'experimental:research_meeting_completed',
        caused_by_event_id: null,
        payload: { completed_result: result },
      }),
    );
    expect(induceConjectureFn).not.toHaveBeenCalled();
    expect(result.considered).toBe(0);
    expect(result.conjectures_created).toBe(0);
    expect(result.cost_usd).toBe(0);
    expect(result.trigger_event_id).toBe(''); // '' sentinel: no anchor event exists
  });

  // YUK-786 — the PRE-LLM grounding stage must actually be in the path: the
  // trace-bearing reader feeds enrich, and the ENRICHED cell (not the bare one)
  // is what reaches induction, in the KC's own subject voice.
  it('enriches the top cells PRE-LLM and hands the grounded cell to induction', async () => {
    const captured: InduceConjectureInput[] = [];
    const enrichEvidenceCellsFn = vi.fn(fakeEnrich);
    const resolveSubjectProfileFn = vi.fn(() => resolveSubjectProfile('math'));
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_a']))),
      enrichEvidenceCellsFn,
      resolveSubjectProfileFn,
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        captured.push(input);
        return fakeInduced(input);
      }),
    });

    await runResearchMeetingNightly({} as never, deps);

    // enrich saw the reasoning traces the list reader carried…
    expect(enrichEvidenceCellsFn).toHaveBeenCalledTimes(1);
    const enrichInput = enrichEvidenceCellsFn.mock.calls[0][1];
    expect(enrichInput.cells).toHaveLength(1);
    expect(enrichInput.reasoningTraceByAttemptId?.get('a_k_a_0')).toBe('trace of a_k_a_0');

    // …and induction received the grounded cell, not the 7-scalar one.
    expect(captured).toHaveLength(1);
    const cell = captured[0].cells[0];
    expect(cell.knowledge_name).toBe('name of k_a');
    expect(cell.subject_display_name).toBe('语文');
    expect(cell.samples.map((s) => s.reasoning_trace)).toEqual([
      'trace of a_k_a_0',
      'trace of b_k_a_0',
    ]);
    // Prompt profile resolution follows the same injected collaborator discipline
    // as the rest of the job.
    expect(resolveSubjectProfileFn).toHaveBeenCalledWith('yuwen');
    expect(captured[0].subjectProfile?.id).toBe('math');
  });

  it('loads question, parent, and answer images and hands their real bytes to induction', async () => {
    const captured: InduceConjectureInput[] = [];
    const loadEvidenceImagesFn = vi.fn(
      async (_db: unknown, refs: readonly ConjectureEvidenceAssetRef[]) => fakeLoadedImages(refs),
    );
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_visual']))),
      enrichEvidenceCellsFn: vi.fn(async (db, input) =>
        (await fakeEnrich(db, input)).map((cell) => ({
          ...cell,
          samples: cell.samples.map((sample, index) =>
            index === 0
              ? {
                  ...sample,
                  question_image_refs: ['asset_question'],
                  parent_question_image_refs: ['asset_parent'],
                  answer_image_refs: ['asset_answer'],
                }
              : sample,
          ),
        })),
      ),
      loadEvidenceImagesFn,
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        captured.push(input);
        return fakeInduced(input);
      }),
    });

    await runResearchMeetingNightly({} as never, deps);

    expect(loadEvidenceImagesFn).toHaveBeenCalledTimes(1);
    expect(loadEvidenceImagesFn.mock.calls[0][1]).toEqual([
      {
        asset_id: 'asset_question',
        attempt_event_id: 'a_k_visual_0',
        source: 'question',
      },
      {
        asset_id: 'asset_parent',
        attempt_event_id: 'a_k_visual_0',
        source: 'parent_question',
      },
      {
        asset_id: 'asset_answer',
        attempt_event_id: 'a_k_visual_0',
        source: 'answer',
      },
    ]);
    expect(captured[0].evidenceImages).toEqual([
      expect.objectContaining({ asset_id: 'asset_question', data: 'BASE64_asset_question' }),
      expect.objectContaining({ asset_id: 'asset_parent', data: 'BASE64_asset_parent' }),
      expect.objectContaining({ asset_id: 'asset_answer', data: 'BASE64_asset_answer' }),
    ]);
  });

  it('does not call induction when enrichment filters every sample as ungrounded', async () => {
    const induceConjectureFn = vi.fn(async (input: InduceConjectureInput) => fakeInduced(input));
    const writeEventFn = vi.fn(async (_db: unknown, input: WriteEventInput) => input.id);
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_visual']))),
      enrichEvidenceCellsFn: vi.fn(async (db, input) =>
        (await fakeEnrich(db, input)).map((cell) => ({
          ...cell,
          samples: [],
          evidence_event_ids: [],
          recurrence_count: 0,
        })),
      ),
      induceConjectureFn,
      writeEventFn,
    });

    const result = await runResearchMeetingNightly({} as never, deps);

    expect(induceConjectureFn).not.toHaveBeenCalled();
    expect(writeEventFn).toHaveBeenCalledTimes(2);
    expect(writeEventFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'experimental:research_meeting_completed',
        caused_by_event_id: null,
      }),
    );
    expect(result).toMatchObject({
      considered: 0,
      conjectures_created: 0,
      cells_failed: 0,
      trigger_event_id: '',
    });
  });

  it('requires the recurrence floor after mutable evidence is filtered', async () => {
    const induceConjectureFn = vi.fn(async (input: InduceConjectureInput) => fakeInduced(input));
    const loadEvidenceImagesFn = vi.fn(async () => []);
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(failuresForKcs(['k_once']))),
      enrichEvidenceCellsFn: vi.fn(async (db, input) =>
        (await fakeEnrich(db, input)).map((cell) => ({
          ...cell,
          // One of two raw attempts was filtered because its historical context is not reproducible.
          samples: cell.samples.slice(1),
          evidence_event_ids: cell.evidence_event_ids.slice(1),
          recurrence_count: 1,
        })),
      ),
      induceConjectureFn,
      loadEvidenceImagesFn,
    });

    const result = await runResearchMeetingNightly({} as never, deps);

    expect(result.considered).toBe(0);
    expect(induceConjectureFn).not.toHaveBeenCalled();
    expect(loadEvidenceImagesFn).not.toHaveBeenCalled();
  });

  it('retains full reproducible recurrence and provenance beyond the prompt sample cap', async () => {
    const rawFailures = [
      failure('a_repro', ['k_repro'], 'concept_confusion'),
      failure('b_repro', ['k_repro'], 'concept_confusion'),
      failure('c_repro', ['k_repro'], 'concept_confusion'),
      failure('d_repro', ['k_repro'], 'concept_confusion'),
    ];
    const capturedCells: EnrichedEvidenceCell[] = [];
    const proposals: WriteAiProposalInput[] = [];
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => withTraces(rawFailures)),
      enrichEvidenceCellsFn: vi.fn(async (db, input) =>
        (await fakeEnrich(db, input)).map((cell) => ({
          ...cell,
          // Prompt text remains representative/capped, but enrichment's ids/count cover all
          // reproducible attempts.
          samples: cell.samples.slice(0, 2),
        })),
      ),
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        capturedCells.push(input.cells[0]);
        return fakeInduced(input);
      }),
      writeAiProposalFn: vi.fn(async (_db, input) => {
        proposals.push(input);
        return 'proposal_repro';
      }),
    });

    await runResearchMeetingNightly({} as never, deps);

    const evidenceEventIds = capturedCells[0].evidence_event_ids;
    expect(capturedCells[0].samples).toHaveLength(2);
    expect(capturedCells[0].recurrence_count).toBe(4);
    expect(evidenceEventIds).toHaveLength(4);
    expect(proposals[0].payload.evidence_refs).toEqual(
      evidenceEventIds.map((id) => ({ kind: 'event', id })),
    );
    expect(proposals[0].payload.proposed_change).toMatchObject({ recurrence_count: 4 });
  });

  it('bounds each grounding batch by the remaining top-K capacity', async () => {
    const enrichEvidenceCellsFn = vi.fn(fakeEnrich);
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () =>
        withTraces(failuresForKcs(['k_a', 'k_b', 'k_c', 'k_d', 'k_e'])),
      ),
      enrichEvidenceCellsFn,
    });

    await runResearchMeetingNightly({} as never, deps);
    expect(enrichEvidenceCellsFn.mock.calls[0][1].cells).toHaveLength(
      RESEARCH_MEETING_MAX_CONJECTURES,
    );
  });

  it('refills grounded top-K from lower salience cells when the leading cells are invalid', async () => {
    const enrichEvidenceCellsFn = vi.fn(async (db, input) =>
      (await fakeEnrich(db, input)).map((cell) =>
        ['k_a', 'k_b', 'k_c'].includes(cell.knowledge_id)
          ? { ...cell, samples: [], evidence_event_ids: [], recurrence_count: 0 }
          : cell,
      ),
    );
    const inducedKnowledgeIds: string[] = [];
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () =>
        withTraces(failuresForKcs(['k_a', 'k_b', 'k_c', 'k_d', 'k_e'])),
      ),
      enrichEvidenceCellsFn,
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        inducedKnowledgeIds.push(input.cells[0].knowledge_id);
        return fakeInduced(input);
      }),
    });

    const result = await runResearchMeetingNightly({} as never, deps);

    expect(enrichEvidenceCellsFn).toHaveBeenCalledTimes(2);
    const firstBatch = enrichEvidenceCellsFn.mock.calls[0][1].cells as EvidenceCell[];
    const secondBatch = enrichEvidenceCellsFn.mock.calls[1][1].cells as EvidenceCell[];
    expect(firstBatch.map((cell) => cell.knowledge_id)).toEqual(['k_a', 'k_b', 'k_c']);
    expect(secondBatch.map((cell) => cell.knowledge_id)).toEqual(['k_d', 'k_e']);
    expect(result.considered).toBe(2);
    expect(inducedKnowledgeIds.sort()).toEqual(['k_d', 'k_e']);
  });

  it('refills top-K after unloadable evidence images instead of starving later cells', async () => {
    const inducedKnowledgeIds: string[] = [];
    const loadEvidenceImagesFn = vi.fn(
      async (_db: unknown, refs: readonly ConjectureEvidenceAssetRef[]) => {
        const assetId = refs[0]?.asset_id ?? '';
        if (['asset_k_a', 'asset_k_b', 'asset_k_c'].includes(assetId)) {
          throw new Error(`missing R2 object: ${assetId}`);
        }
        return fakeLoadedImages(refs);
      },
    );
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () =>
        withTraces(failuresForKcs(['k_a', 'k_b', 'k_c', 'k_d', 'k_e'])),
      ),
      enrichEvidenceCellsFn: vi.fn(async (db, input) =>
        (await fakeEnrich(db, input)).map((cell) => ({
          ...cell,
          samples: cell.samples.map((sample, index) =>
            index === 0
              ? { ...sample, question_image_refs: [`asset_${cell.knowledge_id}`] }
              : sample,
          ),
        })),
      ),
      loadEvidenceImagesFn,
      induceConjectureFn: vi.fn(async (input: InduceConjectureInput) => {
        inducedKnowledgeIds.push(input.cells[0].knowledge_id);
        return fakeInduced(input);
      }),
    });

    const result = await runResearchMeetingNightly({} as never, deps);

    expect(loadEvidenceImagesFn).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({ considered: 2, conjectures_created: 2, cells_failed: 0 });
    expect(inducedKnowledgeIds.sort()).toEqual(['k_d', 'k_e']);
  });

  it('does not run the grounding read on an empty night', async () => {
    const enrichEvidenceCellsFn = vi.fn(fakeEnrich);
    const deps = baseDeps({
      getFailureAttemptsWithTraceFn: vi.fn(async () => []),
      enrichEvidenceCellsFn,
    });
    await runResearchMeetingNightly({} as never, deps);
    expect(enrichEvidenceCellsFn).not.toHaveBeenCalled();
  });

  it('runs the A13 reconcile loop and surfaces the reconciled count (U8)', async () => {
    const reconcileFn = vi.fn(async () => ({ reconciled: 2, skipped: 1 }));
    // No failures → empty propose half, isolating the reconcile wiring assertion.
    const deps = baseDeps({ reconcileFn, getFailureAttemptsWithTraceFn: vi.fn(async () => []) });
    const result = await runResearchMeetingNightly({} as never, deps);
    expect(reconcileFn).toHaveBeenCalledTimes(1);
    expect(result.reconciled).toBe(2);
    expect(result.reconcile_skipped).toBe(1);
  });
});

describe('buildResearchMeetingNightlyHandler', () => {
  it('fails closed when pg-boss invokes the handler without a job id', async () => {
    const handler = buildResearchMeetingNightlyHandler({} as never);
    await expect(handler([])).rejects.toThrow(
      'research_meeting_nightly: handler invoked without a pg-boss job id',
    );
  });
});

describe('planConjectureEvidenceImageLoad', () => {
  const ref = (asset_id: string): ConjectureEvidenceAssetRef => ({
    asset_id,
    attempt_event_id: 'attempt_1',
    source: 'question',
  });

  it('marks unsupported image MIME types for lossless packet-preserving transcode', () => {
    expect(
      planConjectureEvidenceImageLoad(
        [ref('bmp'), ref('png')],
        [
          {
            id: 'bmp',
            mime_type: 'image/bmp',
            byte_size: 100,
            width: 10,
            height: 10,
          },
          {
            id: 'png',
            mime_type: 'image/png',
            byte_size: 100,
            width: 10,
            height: 10,
          },
        ],
      ),
    ).toEqual({
      loadableRefs: [ref('bmp'), ref('png')],
      transcodeAssetIds: ['bmp'],
    });
  });

  it('rejects image formats outside the runner/BMP decoder allowlist', () => {
    expect(() =>
      planConjectureEvidenceImageLoad(
        [ref('svg')],
        [
          {
            id: 'svg',
            mime_type: 'image/svg+xml',
            byte_size: 100,
            width: null,
            height: null,
          },
        ],
      ),
    ).toThrow(/unsupported MIME/);
  });

  it('defers absent metadata dimensions to actual-byte decode for standard uploads', () => {
    expect(
      planConjectureEvidenceImageLoad(
        [ref('png')],
        [
          {
            id: 'png',
            mime_type: 'image/png',
            byte_size: 100,
            width: null,
            height: null,
          },
        ],
      ),
    ).toEqual({ loadableRefs: [ref('png')], transcodeAssetIds: [] });

    expect(
      planConjectureEvidenceImageLoad(
        [ref('bmp')],
        [
          {
            id: 'bmp',
            mime_type: 'image/bmp',
            byte_size: 100,
            width: null,
            height: null,
          },
        ],
      ),
    ).toEqual({ loadableRefs: [ref('bmp')], transcodeAssetIds: ['bmp'] });
  });

  it('counts recurring refs to one asset once for byte and pixel guards', () => {
    const recurring = [
      ref('same'),
      { ...ref('same'), attempt_event_id: 'attempt_2' },
      { ...ref('same'), attempt_event_id: 'attempt_3' },
    ];
    expect(
      planConjectureEvidenceImageLoad(recurring, [
        {
          id: 'same',
          mime_type: 'image/png',
          byte_size: Math.floor(RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL / 8),
          width: 10_000_000,
          height: 1,
        },
      ]),
    ).toEqual({ loadableRefs: recurring, transcodeAssetIds: [] });
  });

  it('rejects aggregate bytes and decoded pixels before any image fetch', () => {
    expect(() =>
      planConjectureEvidenceImageLoad(
        [ref('large')],
        [
          {
            id: 'large',
            mime_type: 'image/png',
            byte_size: RESEARCH_MEETING_MAX_IMAGE_BYTES_PER_CELL + 1,
            width: 10,
            height: 10,
          },
        ],
      ),
    ).toThrow(/bytes/);
    expect(() =>
      planConjectureEvidenceImageLoad(
        [ref('wide')],
        [
          {
            id: 'wide',
            mime_type: 'image/webp',
            byte_size: 100,
            width: RESEARCH_MEETING_MAX_IMAGE_PIXELS_PER_CELL + 1,
            height: 1,
          },
        ],
      ),
    ).toThrow(/pixels/);
  });
});

describe('defaultLoadEvidenceImages', () => {
  it('fetches each asset once, transcodes unsupported images, then expands occurrences', async () => {
    // Minimal 1×1, 24-bit BMP (54-byte header + one four-byte-padded BGR row).
    const bmp = Buffer.alloc(58);
    bmp.write('BM', 0, 'ascii');
    bmp.writeUInt32LE(bmp.length, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(1, 18);
    bmp.writeInt32LE(1, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    bmp.writeUInt32LE(4, 34);
    bmp.set([255, 255, 255, 0], 54);
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#000000' },
    })
      .png()
      .toBuffer();
    const metadata = [
      {
        id: 'asset_bmp',
        mime_type: 'image/bmp',
        byte_size: bmp.byteLength,
        width: 1,
        height: 1,
      },
      {
        id: 'asset_png',
        mime_type: 'image/png',
        byte_size: png.byteLength,
        // Standard generic upload/PDF/DOCX writers do not currently persist dimensions.
        width: null,
        height: null,
      },
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => metadata),
        })),
      })),
    };
    const imageFetchFn = vi.fn(async (assetIds: string[]) =>
      assetIds.map((assetId) =>
        assetId === 'asset_bmp'
          ? { data: bmp.toString('base64'), mediaType: 'image/bmp' }
          : { data: png.toString('base64'), mediaType: 'image/png' },
      ),
    );
    const refs: ConjectureEvidenceAssetRef[] = [
      { asset_id: 'asset_bmp', attempt_event_id: 'attempt_1', source: 'question' },
      { asset_id: 'asset_bmp', attempt_event_id: 'attempt_2', source: 'question' },
      { asset_id: 'asset_png', attempt_event_id: 'attempt_2', source: 'answer' },
    ];

    const loaded = await defaultLoadEvidenceImages(
      db as never,
      refs,
      imageFetchFn as typeof import('@/server/ai/judges/steps-judge').defaultImageFetch,
    );

    expect(imageFetchFn).toHaveBeenCalledTimes(1);
    expect(imageFetchFn.mock.calls[0][0]).toEqual(['asset_bmp', 'asset_png']);
    expect(loaded.map((image) => image.asset_id)).toEqual(['asset_bmp', 'asset_png']);
    expect(loaded.map((image) => image.mediaType)).toEqual(['image/png', 'image/png']);
    expect(loaded[0].occurrences).toEqual([
      { attempt_event_id: 'attempt_1', source: 'question' },
      { attempt_event_id: 'attempt_2', source: 'question' },
    ]);
    expect((await sharp(Buffer.from(loaded[0].data, 'base64')).metadata()).format).toBe('png');
  });
});
