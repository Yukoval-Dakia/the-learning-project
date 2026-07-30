import type { InduceConjectureResult } from '@/server/agency/conjecture/induce';
import {
  buildGroundingReviewArtifacts,
  createGroundingCanaryTemplate,
  scoreGroundingBlindPacket,
  scoreGroundingCanaryPacket,
  selectGroundingCandidates,
} from '@/server/grounding-gate/artifacts';
import type { GroundingGateCandidate } from '@/server/grounding-gate/candidates';
import { describe, expect, it } from 'vitest';

function candidate(key: string): GroundingGateCandidate {
  const [causeCategory, knowledgeId] = key.split('::');
  return {
    cell: {
      key,
      cause_category: causeCategory,
      knowledge_id: knowledgeId,
      recurrence_count: 2,
      evidence_event_ids: [`${key}:attempt:1`, `${key}:attempt:2`],
      has_owner_cause: true,
      theta_hat: null,
      theta_precision: null,
      baseline_p: null,
      probe_here: true,
      knowledge_name: '链式法则',
      subject_id: 'math',
      subject_display_name: '数学',
      samples: [
        {
          attempt_event_id: `${key}:attempt:1`,
          question_id: `${key}:question:1`,
          question_prompt_md: '求导。',
          question_reference_md: '使用链式法则。',
          question_choices_md: null,
          question_image_refs: [],
          question_figures: [],
          parent_question_id: null,
          parent_question_prompt_md: null,
          parent_question_reference_md: null,
          parent_question_choices_md: null,
          parent_question_image_refs: [],
          parent_question_figures: [],
          answer_md: '直接相乘。',
          answer_image_refs: [],
          reasoning_trace: '我把两层导数直接相乘。',
          cause_category: causeCategory,
          cause_source: 'user',
          cause_attribution_md: '链式法则理解错误',
        },
      ],
    },
    evidence_images: [],
    prior_claim_md: null,
  };
}

function induced(): InduceConjectureResult {
  return {
    outcome: 'proposal',
    draft: {
      kind: 'proposal',
      claim_md: '把链式法则误解为逐层导数直接相乘。',
      knowledge_id: 'kc-chain',
      evidence_event_ids: ['attempt-1', 'attempt-2'],
      diagnostic_spec: {
        schema_version: 1,
        target_error_rule_md: '把复合函数逐层求导误解为直接相乘。',
        trigger_conditions_md: '题目要求对至少两层复合函数求导。',
        scope_boundary_md: '不覆盖普通乘积求导。',
        expected_wrong_answer_signature_md: '没有保留内层输入便直接相乘。',
      },
      probe_md: '请完成一道未教学的链式求导题。',
      probe_reference_md: '应先识别外层与内层并相乘。',
      followup_probe_md: '换一个函数再做一次。',
      followup_probe_reference_md: '仍需正确应用链式法则。',
      probe_spec: {
        schema_version: 2,
        prompt_md: '请完成一道未教学的链式求导题。',
        reference_md: '应先识别外层与内层并相乘。',
        expected_target_error_answer_md: '把各层导数脱离原输入直接相乘。',
        elicits_target_error_reason_md: '保留多层复合这一触发条件。',
        context_kind: 'abstract',
        representation_kind: 'symbolic',
        response_mode: 'short_answer',
        gold_response_signature: {
          kind: 'text',
          response_md: '应先识别外层与内层并相乘。',
        },
        target_error_response_signature: {
          kind: 'text',
          response_md: '把各层导数脱离原输入直接相乘。',
        },
      },
      followup_probe_spec: {
        schema_version: 2,
        prompt_md: '换一个函数再做一次。',
        reference_md: '仍需正确应用链式法则。',
        expected_target_error_answer_md: '仍把各层导数脱离原输入直接相乘。',
        elicits_target_error_reason_md: '以应用语境复测同一目标错误。',
        context_kind: 'applied',
        representation_kind: 'natural_language',
        response_mode: 'short_answer',
        gold_response_signature: {
          kind: 'text',
          response_md: '仍需正确应用链式法则。',
        },
        target_error_response_signature: {
          kind: 'text',
          response_md: '仍把各层导数脱离原输入直接相乘。',
        },
      },
      probe_quality: {
        schema_version: 3,
        passed: true,
        attempts: [
          {
            attempt: 1,
            outcome: 'passed',
            failure_codes: [],
            explanation_md: '范围、目标错误与双题独立性均通过。',
            author_task_run_id: 'run-author',
            reviewer_task_run_id: 'run-review',
          },
        ],
        final_review: {
          verdict: 'pass',
          failure_codes: [],
          explanation_md: '范围、目标错误与双题独立性均通过。',
        },
        reviewed_hypothesis: {
          kind: 'proposal',
          claim_md: '把链式法则误解为逐层导数直接相乘。',
          knowledge_id: 'kc-chain',
          evidence_event_ids: ['attempt-1', 'attempt-2'],
          diagnostic_spec: {
            schema_version: 1,
            target_error_rule_md: '把复合函数逐层求导误解为直接相乘。',
            trigger_conditions_md: '题目要求对至少两层复合函数求导。',
            scope_boundary_md: '不覆盖普通乘积求导。',
            expected_wrong_answer_signature_md: '没有保留内层输入便直接相乘。',
          },
          cause_category: 'conceptual',
          recurrence_count: 2,
        },
        reviewed_package: {
          primary: {
            schema_version: 2,
            prompt_md: '请完成一道未教学的链式求导题。',
            reference_md: '应先识别外层与内层并相乘。',
            expected_target_error_answer_md: '把各层导数脱离原输入直接相乘。',
            elicits_target_error_reason_md: '保留多层复合这一触发条件。',
            context_kind: 'abstract',
            representation_kind: 'symbolic',
            response_mode: 'short_answer',
            gold_response_signature: {
              kind: 'text',
              response_md: '应先识别外层与内层并相乘。',
            },
            target_error_response_signature: {
              kind: 'text',
              response_md: '把各层导数脱离原输入直接相乘。',
            },
          },
          followup: {
            schema_version: 2,
            prompt_md: '换一个函数再做一次。',
            reference_md: '仍需正确应用链式法则。',
            expected_target_error_answer_md: '仍把各层导数脱离原输入直接相乘。',
            elicits_target_error_reason_md: '以应用语境复测同一目标错误。',
            context_kind: 'applied',
            representation_kind: 'natural_language',
            response_mode: 'short_answer',
            gold_response_signature: {
              kind: 'text',
              response_md: '仍需正确应用链式法则。',
            },
            target_error_response_signature: {
              kind: 'text',
              response_md: '仍把各层导数脱离原输入直接相乘。',
            },
          },
          predicted_p: 0.4,
        },
      },
      cause_category: 'conceptual',
      recurrence_count: 2,
      predicted_p: 0.4,
      discriminating: true,
      agreement_count: 2,
    },
    primary_task_run_id: 'run-primary',
    confidence: 2 / 3,
    confidence_capped: false,
    samples: 3,
    task_run_ids: ['run-1', 'run-2', 'run-3'],
    cost_usd: 0.12,
    votes: { proposal: 2, abstain: 1, invalid: 0, failed: 0 },
    probe_quality_attempts: [
      {
        attempt: 1,
        outcome: 'passed',
        failure_codes: [],
        explanation_md: '范围、目标错误与双题独立性均通过。',
        author_task_run_id: 'run-author',
        reviewer_task_run_id: 'run-review',
      },
    ],
  };
}

function blindPacket(count = 8) {
  const selected = selectGroundingCandidates(
    Array.from({ length: count }, (_, index) => candidate(`conceptual::kc-${index}`)),
    count,
    'stable-seed',
  );
  return buildGroundingReviewArtifacts({
    gateId: 'gate-1',
    sourceBackupSha256: 'a'.repeat(64),
    generatedAt: new Date('2026-07-29T00:00:00.000Z'),
    codeRevision: 'abc123',
    selectionSeed: 'stable-seed',
    window: {
      from: new Date('2026-07-15T00:00:00.000Z'),
      to: new Date('2026-07-29T00:00:00.000Z'),
    },
    eligibleCount: count,
    results: selected.map((item) => ({
      selected: item,
      induced: induced(),
      imagesByAttemptId: new Map(),
    })),
  }).blind;
}

describe('selectGroundingCandidates', () => {
  it('is deterministic across source order', () => {
    const candidates = Array.from({ length: 10 }, (_, index) =>
      candidate(`conceptual::kc-${index}`),
    );
    const forward = selectGroundingCandidates(candidates, 8, 'seed');
    const reverse = selectGroundingCandidates([...candidates].reverse(), 8, 'seed');
    expect(forward.map((item) => item.candidate.cell.key)).toEqual(
      reverse.map((item) => item.candidate.cell.key),
    );
    expect(forward.map((item) => item.cluster_id)).toEqual([
      'cluster-01',
      'cluster-02',
      'cluster-03',
      'cluster-04',
      'cluster-05',
      'cluster-06',
      'cluster-07',
      'cluster-08',
    ]);
  });

  it('fails instead of shrinking a requested real-data gate', () => {
    expect(() =>
      selectGroundingCandidates(
        Array.from({ length: 5 }, (_, index) => candidate(`conceptual::kc-${index}`)),
        6,
        'seed',
      ),
    ).toThrow('only 5 eligible real clusters');
  });
});

describe('blind review artifacts', () => {
  it('separates blind evidence from private lineage', () => {
    const selected = selectGroundingCandidates(
      Array.from({ length: 6 }, (_, index) => candidate(`conceptual::kc-${index}`)),
      6,
      'seed',
    );
    const artifacts = buildGroundingReviewArtifacts({
      gateId: 'gate-1',
      sourceBackupSha256: 'b'.repeat(64),
      generatedAt: new Date('2026-07-29T00:00:00.000Z'),
      codeRevision: 'abc123',
      selectionSeed: 'seed',
      window: {
        from: new Date('2026-07-15T00:00:00.000Z'),
        to: new Date('2026-07-29T00:00:00.000Z'),
      },
      eligibleCount: 6,
      results: selected.map((item) => ({
        selected: item,
        induced: induced(),
        imagesByAttemptId: new Map(),
      })),
    });
    const blindText = JSON.stringify(artifacts.blind);
    expect(blindText).not.toContain('task_run');
    expect(blindText).not.toContain('attempt_event_ids');
    expect(blindText).not.toContain('knowledge_id');
    expect(artifacts.blind.requested_sample_count).toBe(6);
    expect(artifacts.blind.selection_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifacts.blind.items[0].review.grounded_proposal).toBeNull();
    expect(artifacts.blind.items[0].shadow_output).toMatchObject({
      outcome: 'proposal',
      diagnostic_spec: {
        trigger_conditions_md: '题目要求对至少两层复合函数求导。',
      },
      probe_spec: {
        expected_target_error_answer_md: '把各层导数脱离原输入直接相乘。',
      },
    });
    expect(artifacts.privateMap.clusters[0].task_run_ids).toEqual(['run-1', 'run-2', 'run-3']);
    expect(artifacts.privateMap.clusters[0].probe_quality_attempts).toHaveLength(1);
  });

  it('fails closed with attempt lineage when effective cause data is missing', () => {
    const invalid = candidate('conceptual::kc-invalid');
    invalid.cell.samples[0].cause_source = null;
    expect(() =>
      buildGroundingReviewArtifacts({
        gateId: 'gate-1',
        sourceBackupSha256: 'b'.repeat(64),
        generatedAt: new Date('2026-07-29T00:00:00.000Z'),
        codeRevision: 'abc123',
        selectionSeed: 'seed',
        window: {
          from: new Date('2026-07-15T00:00:00.000Z'),
          to: new Date('2026-07-29T00:00:00.000Z'),
        },
        eligibleCount: 1,
        results: [
          {
            selected: { cluster_id: 'cluster-01', candidate: invalid },
            induced: induced(),
            imagesByAttemptId: new Map(),
          },
        ],
      }),
    ).toThrow('conceptual::kc-invalid:attempt:1');
  });
});

describe('scoreGroundingBlindPacket', () => {
  it('passes at exactly 80 percent with zero redlines', () => {
    const packet = blindPacket(10);
    for (const [index, item] of packet.items.entries()) {
      item.review = {
        grounded_proposal: index < 8,
        discipline_hallucination: false,
        claim_probe_mismatch: false,
        severe_factual_error: false,
        notes: '',
      };
    }
    const score = scoreGroundingBlindPacket(packet);
    expect(score.status).toBe('pass');
    expect(score.grounding_rate).toBe(0.8);
    expect(score.expansion_allowed).toBe(true);
  });

  it('fails on any redline even when grounding is otherwise high', () => {
    const packet = blindPacket(8);
    for (const item of packet.items) {
      item.review = {
        grounded_proposal: true,
        discipline_hallucination: false,
        claim_probe_mismatch: false,
        severe_factual_error: false,
        notes: '',
      };
    }
    packet.items[0].review.claim_probe_mismatch = true;
    const score = scoreGroundingBlindPacket(packet);
    expect(score.status).toBe('fail');
    expect(score.redlines.claim_probe_mismatch).toBe(1);
    expect(score.expansion_allowed).toBe(false);
  });

  it('stays incomplete while any owner label is blank', () => {
    const packet = blindPacket(8);
    for (const item of packet.items.slice(0, 7)) {
      item.review = {
        grounded_proposal: true,
        discipline_hallucination: false,
        claim_probe_mismatch: false,
        severe_factual_error: false,
        notes: '',
      };
    }
    const score = scoreGroundingBlindPacket(packet);
    expect(score.status).toBe('incomplete');
    expect(score.grounding_rate).toBeNull();
  });

  it('reports a known blind redline even while other labels are incomplete', () => {
    const packet = blindPacket(8);
    packet.items[0].review.severe_factual_error = true;
    const score = scoreGroundingBlindPacket(packet);
    expect(score.status).toBe('incomplete');
    expect(score.redlines.severe_factual_error).toBe(1);
    expect(score.requirements.zero_redlines).toBe(false);
  });

  it('fails when an operator prunes an item from the sealed blind selection', () => {
    const packet = blindPacket(8);
    for (const item of packet.items) {
      item.review = {
        grounded_proposal: true,
        discipline_hallucination: false,
        claim_probe_mismatch: false,
        severe_factual_error: false,
        notes: '',
      };
    }
    packet.items.pop();
    const score = scoreGroundingBlindPacket(packet);
    expect(score.status).toBe('fail');
    expect(score.expansion_allowed).toBe(false);
    expect(score.grounding_rate).toBeNull();
    expect(score.requirements.original_sample_count_preserved).toBe(false);
    expect(score.requirements.selection_digest_preserved).toBe(false);
  });

  it('fails when sealed blind evidence changes without changing the item count', () => {
    const packet = blindPacket(8);
    packet.items[0].evidence_samples[0].question_prompt_md = 'tampered prompt';
    const score = scoreGroundingBlindPacket(packet);
    expect(score.status).toBe('fail');
    expect(score.requirements.original_sample_count_preserved).toBe(true);
    expect(score.requirements.selection_digest_preserved).toBe(false);
  });
});

describe('canary gate', () => {
  it('requires ten reviewed runs, monitoring refs, and a stop-switch rehearsal', () => {
    const packet = createGroundingCanaryTemplate({
      gateId: 'gate-1',
      blindScoreSha256: 'c'.repeat(64),
    });
    expect(scoreGroundingCanaryPacket(packet).status).toBe('incomplete');
    packet.owner_cohort_ref = 'owner-cohort-1';
    for (const [index, run] of packet.runs.entries()) {
      run.intervention_ref = `intervention-${index + 1}`;
      run.review = {
        post_reviewed: true,
        discipline_hallucination: false,
        claim_probe_mismatch: false,
        severe_factual_error: false,
        monitoring_snapshot_ref: `monitor-${index + 1}`,
        notes: '',
      };
    }
    packet.stop_switch_rehearsal = {
      control_ref: 'auto-intervention-control',
      audit_ref: 'audit-event-1',
      disabled_before_new_schedule: true,
      existing_records_retained: true,
    };
    const score = scoreGroundingCanaryPacket(packet);
    expect(score.status).toBe('pass');
    expect(score.expansion_allowed).toBe(true);
  });

  it('fails closed and requests disable on a canary redline', () => {
    const packet = createGroundingCanaryTemplate({
      gateId: 'gate-1',
      blindScoreSha256: 'd'.repeat(64),
    });
    packet.owner_cohort_ref = 'owner-cohort-1';
    for (const [index, run] of packet.runs.entries()) {
      run.intervention_ref = `intervention-${index + 1}`;
      run.review = {
        post_reviewed: true,
        discipline_hallucination: false,
        claim_probe_mismatch: false,
        severe_factual_error: index === 0,
        monitoring_snapshot_ref: `monitor-${index + 1}`,
        notes: '',
      };
    }
    packet.stop_switch_rehearsal = {
      control_ref: 'auto-intervention-control',
      audit_ref: 'audit-event-1',
      disabled_before_new_schedule: true,
      existing_records_retained: true,
    };
    const score = scoreGroundingCanaryPacket(packet);
    expect(score.status).toBe('fail');
    expect(score.auto_intervention_should_be_disabled).toBe(true);
    expect(score.expansion_allowed).toBe(false);
  });

  it('requests disable for a known redline even while other canary labels are incomplete', () => {
    const packet = createGroundingCanaryTemplate({
      gateId: 'gate-1',
      blindScoreSha256: 'e'.repeat(64),
    });
    packet.runs[0].review.severe_factual_error = true;
    const score = scoreGroundingCanaryPacket(packet);
    expect(score.status).toBe('incomplete');
    expect(score.redlines.severe_factual_error).toBe(1);
    expect(score.auto_intervention_should_be_disabled).toBe(true);
  });
});
