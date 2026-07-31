import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConjectureProbeQualityAuditT } from '@/core/schema/business';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import { SUBJECT_PROBE_VALIDATOR_POLICY_VERSION } from '@/subjects/probe-quality';
import { prepareSubjectProbeValidatorBlockingCutover } from './subject-probe-validator-cutover';

function pendingConjecture(id: string, subjectValidatorOutcome: 'pass' | 'fail'): ProposalInboxRow {
  const primary = {
    schema_version: 2 as const,
    prompt_md: 'Convert 72 km/h to m/s.',
    reference_md: '20 m/s',
    expected_target_error_answer_md: '72000 m/s',
    elicits_target_error_reason_md: 'Requires converting both parts of the compound unit.',
    context_kind: 'abstract' as const,
    representation_kind: 'symbolic' as const,
    response_mode: 'short_answer' as const,
    gold_response_signature: { kind: 'text' as const, response_md: '20 m/s' },
    target_error_response_signature: { kind: 'text' as const, response_md: '72000 m/s' },
  };
  const followup = {
    schema_version: 2 as const,
    prompt_md: 'Convert 10 m/s to km/h.',
    reference_md: '36 km/h',
    expected_target_error_answer_md: '0.01 km/h',
    elicits_target_error_reason_md: 'Again requires converting distance and denominator time.',
    context_kind: 'applied' as const,
    representation_kind: 'natural_language' as const,
    response_mode: 'short_answer' as const,
    gold_response_signature: { kind: 'text' as const, response_md: '36 km/h' },
    target_error_response_signature: { kind: 'text' as const, response_md: '0.01 km/h' },
  };
  const hypothesis = {
    kind: 'proposal' as const,
    claim_md: 'The learner converts the distance unit but not the denominator time unit.',
    knowledge_id: 'kc-unit',
    evidence_event_ids: ['attempt-1', 'attempt-2'],
    diagnostic_spec: {
      schema_version: 1 as const,
      target_error_rule_md: 'Converts the distance unit but leaves the time denominator unchanged.',
      trigger_conditions_md: 'A compound speed unit must be converted.',
      scope_boundary_md: 'Only covers compound speed conversions.',
      expected_wrong_answer_signature_md: 'The hour-to-second factor is omitted.',
    },
    cause_category: 'unit_error' as const,
    recurrence_count: 2,
  };
  const subjectValidatorResult =
    subjectValidatorOutcome === 'fail'
      ? {
          validator_id: 'math.unit-conversion',
          validator_version: '1',
          outcome: 'fail' as const,
          failure_codes: ['subject_validator_ungradable' as const],
          evidence: {},
        }
      : {
          validator_id: 'math.unit-conversion',
          validator_version: '1',
          outcome: 'pass' as const,
          failure_codes: [],
          evidence: {},
        };
  const probeQuality = {
    schema_version: 4,
    passed: true,
    attempts: [
      {
        attempt: 1,
        outcome: 'passed',
        failure_codes: [],
        explanation_md: 'independent review passed',
        author_task_run_id: 'author-task',
        reviewer_task_run_id: 'reviewer-task',
      },
    ],
    final_review: {
      verdict: 'pass',
      failure_codes: [],
      explanation_md: 'independent review passed',
    },
    reviewed_hypothesis: hypothesis,
    reviewed_package: {
      primary,
      followup,
      predicted_p: 0.4,
    },
    subject_id: 'math',
    policy_version: SUBJECT_PROBE_VALIDATOR_POLICY_VERSION,
    subject_validator_results: [subjectValidatorResult],
  } satisfies ConjectureProbeQualityAuditT;

  return {
    id,
    kind: 'conjecture',
    target: { subject_kind: 'mind_model', subject_id: 'kc-unit' },
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: 'kc-unit' },
      reason_md: 'repeated failures',
      evidence_refs: [],
      proposed_change: {
        claim_md: hypothesis.claim_md,
        knowledge_id: hypothesis.knowledge_id,
        cause_category: hypothesis.cause_category,
        recurrence_count: 2,
        predicted_p: 0.4,
        probe_md: primary.prompt_md,
        probe_reference_md: primary.reference_md,
        followup_probe_md: followup.prompt_md,
        followup_probe_reference_md: followup.reference_md,
        diagnostic_spec: hypothesis.diagnostic_spec,
        probe_spec: primary,
        followup_probe_spec: followup,
        discriminating: true,
        probe_quality: probeQuality,
      },
    },
    status: 'pending',
    proposed_at: new Date('2026-07-30T00:00:00.000Z'),
    decided_at: null,
    actor_ref: 'research_meeting',
    task_run_id: null,
    cost_micro_usd: null,
    source_action: 'experimental:proposal',
    source_subject_kind: 'mind_model',
    signals: null,
    presentation: null,
  };
}

describe('prepareSubjectProbeValidatorBlockingCutover', () => {
  const tx = {} as never;
  const db = {
    transaction: vi.fn(async (fn: (handle: typeof tx) => Promise<void>) => fn(tx)),
  } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does no DB work while validators remain shadow-only', async () => {
    const listPendingConjecturesFn = vi.fn();
    const result = await prepareSubjectProbeValidatorBlockingCutover(db, {
      blockingEnabledFn: () => false,
      listPendingConjecturesFn,
    });

    expect(result).toEqual({ enabled: false, pending_scanned: 0, retired: 0 });
    expect(listPendingConjecturesFn).not.toHaveBeenCalled();
  });

  it('retires only a still-pending shadow failure under the decision lock', async () => {
    const failed = pendingConjecture('failed-proposal', 'fail');
    const passed = pendingConjecture('passed-proposal', 'pass');
    const acquireProposalDecisionLockFn = vi.fn(async () => undefined);
    const writeEventFn = vi.fn(async () => 'correction-event');

    const result = await prepareSubjectProbeValidatorBlockingCutover(db, {
      blockingEnabledFn: () => true,
      listPendingConjecturesFn: vi.fn(async () => [failed, passed]),
      getProposalFn: vi.fn(async (_handle, id) => (id === failed.id ? failed : passed)),
      acquireProposalDecisionLockFn,
      writeEventFn,
      nowFn: () => new Date('2026-07-30T01:00:00.000Z'),
    });

    expect(result).toEqual({ enabled: true, pending_scanned: 2, retired: 1 });
    expect(acquireProposalDecisionLockFn).toHaveBeenCalledWith(tx, failed.id);
    expect(writeEventFn).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actor_kind: 'agent',
        actor_ref: 'subject_probe_validator_blocking_cutover',
        action: 'correct',
        subject_id: failed.id,
        payload: expect.objectContaining({ correction_kind: 'retract' }),
      }),
    );
  });

  it('rechecks status after locking so a concurrent owner decision wins', async () => {
    const failed = pendingConjecture('concurrent-proposal', 'fail');
    const decided = { ...failed, status: 'accepted' as const };
    const writeEventFn = vi.fn(async () => 'correction-event');

    const result = await prepareSubjectProbeValidatorBlockingCutover(db, {
      blockingEnabledFn: () => true,
      listPendingConjecturesFn: vi.fn(async () => [failed]),
      getProposalFn: vi.fn(async () => decided),
      acquireProposalDecisionLockFn: vi.fn(async () => undefined),
      writeEventFn,
    });

    expect(result).toEqual({ enabled: true, pending_scanned: 1, retired: 0 });
    expect(writeEventFn).not.toHaveBeenCalled();
  });
});
