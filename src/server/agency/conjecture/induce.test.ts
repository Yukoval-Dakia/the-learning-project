// YUK-406 Phase 0 / YUK-440 A13 — induceConjecture orchestrator unit tests
// (pure: injected runTaskFn, no DB / AI / R2).

import type {
  ConjectureEvidenceSample,
  EnrichedEvidenceCell,
} from '@/capabilities/agency/server/conjecture/evidence';
import type { ConjectureAbstainDraftT, ConjectureProposalDraftT } from '@/core/schema/business';
import type { TaskTextResult, TaskTextRunFn } from '@/server/ai/provenance';
import { resolveSubjectProfile } from '@/subjects/profile';
import { describe, expect, it, vi } from 'vitest';

import {
  type ConjectureInductionOperationalError,
  type InduceConjectureResult,
  induceConjecture as induceConjectureImpl,
} from './induce';

function proposal(result: InduceConjectureResult): ConjectureProposalDraftT {
  expect(result.outcome).toBe('proposal');
  if (result.outcome !== 'proposal') {
    throw new Error(`expected proposal, received ${result.draft.reason_code}`);
  }
  return result.draft;
}

function abstain(result: InduceConjectureResult): ConjectureAbstainDraftT {
  expect(result.outcome).toBe('abstain');
  if (result.outcome !== 'abstain') {
    throw new Error(`expected abstain, received ${result.draft.claim_md}`);
  }
  return result.draft;
}

/** Helper: produces a TaskTextResult carrying a ConjectureGroupingTask structured_output. */
function groupResult(groups: number[][]): TaskTextResult {
  return { text: '', structured_output: { groups } };
}

function probePackageResult(
  overrides: {
    primaryPrompt?: string;
    primaryReference?: string;
    primaryTargetError?: string;
    followupPrompt?: string;
    followupReference?: string;
    followupTargetError?: string;
    samePresentation?: boolean;
    bareAmbiguousSingleChoice?: boolean;
    taskRunId?: string;
  } = {},
): TaskTextResult {
  return {
    text: '',
    task_run_id: overrides.taskRunId ?? 'probe-author-run',
    structured_output: {
      package: {
        primary: {
          schema_version: 2,
          prompt_md: overrides.primaryPrompt ?? "对 f(x)=sin(x^2)，写出 f'(x)。",
          reference_md: overrides.primaryReference ?? "f'(x)=2x·cos(x^2)",
          expected_target_error_answer_md: overrides.primaryTargetError ?? "f'(x)=cos(x^2)+2x",
          elicits_target_error_reason_md: '必须决定外层与内层导数如何组合。',
          context_kind: 'abstract',
          representation_kind: 'symbolic',
          response_mode: overrides.bareAmbiguousSingleChoice
            ? 'single_choice'
            : 'answer_with_reason',
          gold_response_signature: overrides.bareAmbiguousSingleChoice
            ? { kind: 'choice', option_ids: ['C'] }
            : {
                kind: 'answer_with_reason',
                answer_md: overrides.primaryReference ?? "f'(x)=2x·cos(x^2)",
                required_reason_features_md: ['外层导数乘以内层导数'],
              },
          target_error_response_signature: overrides.bareAmbiguousSingleChoice
            ? { kind: 'choice', option_ids: ['A', 'B', 'D'] }
            : {
                kind: 'answer_with_reason',
                answer_md: overrides.primaryTargetError ?? "f'(x)=cos(x^2)+2x",
                required_reason_features_md: ['把两层导数相加'],
              },
        },
        followup: {
          schema_version: 2,
          prompt_md:
            overrides.followupPrompt ?? '某变化率由 h(t)=cos(t³) 给出，用文字说明其瞬时变化率。',
          reference_md: overrides.followupReference ?? "h'(t)=-3t²·sin(t³)，内外层导数相乘。",
          expected_target_error_answer_md: overrides.followupTargetError ?? "h'(t)=-sin(t³)+3t²",
          elicits_target_error_reason_md: '在应用语境中再次要求组合两层导数。',
          context_kind: overrides.samePresentation ? 'abstract' : 'applied',
          representation_kind: overrides.samePresentation ? 'symbolic' : 'natural_language',
          response_mode: 'answer_with_reason',
          gold_response_signature: {
            kind: 'answer_with_reason',
            answer_md: overrides.followupReference ?? "h'(t)=-3t²·sin(t³)，内外层导数相乘。",
            required_reason_features_md: ['外层导数乘以内层导数'],
          },
          target_error_response_signature: {
            kind: 'answer_with_reason',
            answer_md: overrides.followupTargetError ?? "h'(t)=-sin(t³)+3t²",
            required_reason_features_md: ['把两层导数相加'],
          },
        },
        predicted_p: 0.3,
      },
    },
  };
}

function probeReviewResult(
  verdict: 'pass' | 'fail' = 'pass',
  failureCodes: string[] = [],
  taskRunId = 'probe-review-run',
): TaskTextResult {
  return {
    text: '',
    task_run_id: taskRunId,
    structured_output: {
      review: {
        verdict,
        failure_codes: failureCodes,
        explanation_md:
          verdict === 'pass'
            ? '两题保持同一目标错因，同时改变情境与表征。'
            : '探针没有稳定复现冻结的目标错因。',
      },
    },
  };
}

function unitSample(): TaskTextResult {
  return {
    text: JSON.stringify({
      kind: 'proposal',
      claim_md: '你在复合速度单位换算时只换分子距离单位，忘记换分母时间单位。',
      knowledge_id: 'k_chain_rule',
      evidence_event_ids: ['e_a', 'e_b'],
      diagnostic_spec: {
        schema_version: 1,
        target_error_rule_md: '只换算分子距离单位，不换算分母时间单位。',
        trigger_conditions_md: '题目要求在 km/h 与 m/s 之间做速度单位换算。',
        scope_boundary_md: '只覆盖复合速度单位换算。',
        expected_wrong_answer_signature_md: '分母的每小时或每秒倍率保持不变。',
      },
      cause_category: 'unit_error',
      recurrence_count: 3,
    }),
  };
}

function unitCell(): EnrichedEvidenceCell {
  return cell({
    key: 'unit_error::k_chain_rule',
    cause_category: 'unit_error',
    samples: [
      evidenceSample({ cause_category: 'unit_error' }),
      evidenceSample({
        attempt_event_id: 'e_b',
        question_id: 'q_b',
        cause_category: 'unit_error',
      }),
    ],
  });
}

function unitProbePackageResult(input: {
  taskRunId: string;
  primaryGold?: string;
}): TaskTextResult {
  const primaryGold = input.primaryGold ?? '20 m/s';
  return {
    text: '',
    task_run_id: input.taskRunId,
    structured_output: {
      package: {
        primary: {
          schema_version: 2,
          prompt_md: 'Convert 72 km/h to m/s.',
          reference_md: primaryGold,
          expected_target_error_answer_md: '72000 m/s',
          elicits_target_error_reason_md: 'Requires converting both parts of the compound unit.',
          context_kind: 'abstract',
          representation_kind: 'symbolic',
          response_mode: 'short_answer',
          gold_response_signature: { kind: 'text', response_md: primaryGold },
          target_error_response_signature: { kind: 'text', response_md: '72000 m/s' },
        },
        followup: {
          schema_version: 2,
          prompt_md: '将 10 m/s 换算为 km/h。',
          reference_md: '36 km/h',
          expected_target_error_answer_md: '0.01 km/h',
          elicits_target_error_reason_md: '再次要求同时换算距离和分母时间单位。',
          context_kind: 'applied',
          representation_kind: 'natural_language',
          response_mode: 'short_answer',
          gold_response_signature: { kind: 'text', response_md: '36 km/h' },
          target_error_response_signature: { kind: 'text', response_md: '0.01 km/h' },
        },
        predicted_p: 0.3,
      },
    },
  };
}

function withPassingProbeQuality(runTaskFn: TaskTextRunFn): TaskTextRunFn {
  return async (kind, input, ctx) => {
    if (kind === 'ConjectureProbeAuthorTask') return probePackageResult();
    if (kind === 'ConjectureProbeReviewTask') return probeReviewResult();
    return runTaskFn(kind, input, ctx);
  };
}

async function induceConjecture(
  input: Parameters<typeof induceConjectureImpl>[0],
): Promise<InduceConjectureResult> {
  return induceConjectureImpl({
    ...input,
    runTaskFn: withPassingProbeQuality(input.runTaskFn),
  });
}

/** YUK-786 — one first-hand evidence sample, already wrapped by the enrich step. */
function evidenceSample(
  overrides: Partial<ConjectureEvidenceSample> = {},
): ConjectureEvidenceSample {
  return {
    attempt_event_id: 'e_a',
    question_id: 'q_a',
    question_prompt_md:
      '<untrusted_learner_text>求 f(x)=sin(x^2) 的导数。</untrusted_learner_text>',
    question_reference_md: "<untrusted_learner_text>f'(x)=2x·cos(x^2)</untrusted_learner_text>",
    question_choices_md: null,
    question_image_refs: [],
    question_figures: [],
    parent_question_id: null,
    parent_question_prompt_md: null,
    parent_question_reference_md: null,
    parent_question_choices_md: null,
    parent_question_image_refs: [],
    parent_question_figures: [],
    answer_md: '<untrusted_learner_text>cos(x^2)·2x 写成了 cos(x^2)+2x</untrusted_learner_text>',
    answer_image_refs: [],
    reasoning_trace:
      '<untrusted_learner_text>我先分别求了两层的导数，然后把它们加起来。</untrusted_learner_text>',
    cause_category: 'concept_confusion',
    cause_source: 'agent',
    cause_attribution_md: '把复合函数的层间组合方式记错。',
    ...overrides,
  };
}

function cell(overrides: Partial<EnrichedEvidenceCell> = {}): EnrichedEvidenceCell {
  return {
    key: 'concept_confusion::k_chain_rule',
    cause_category: 'concept_confusion',
    knowledge_id: 'k_chain_rule',
    recurrence_count: 3,
    evidence_event_ids: ['e_a', 'e_b', 'e_c'],
    theta_hat: -0.4,
    theta_precision: 1.2,
    baseline_p: 0.35,
    probe_here: true,
    has_owner_cause: true,
    // YUK-786 grounding packet — the induction contract now REQUIRES it.
    knowledge_name: '链式法则',
    subject_id: 'math',
    subject_display_name: '数学',
    samples: [evidenceSample(), evidenceSample({ attempt_event_id: 'e_b', question_id: 'q_b' })],
    ...overrides,
  };
}

function sample(
  claim: string,
  extra: {
    predicted_p?: number;
    discriminating?: boolean;
    probe_md?: string;
    probe_reference_md?: string;
    followup_probe_md?: string;
    followup_probe_reference_md?: string;
    trigger_conditions_md?: string;
    scope_boundary_md?: string;
  } = {},
): TaskTextResult {
  return {
    text: `reasoning...\n${JSON.stringify({
      kind: 'proposal',
      claim_md: claim,
      knowledge_id: 'k_chain_rule',
      evidence_event_ids: ['e_a', 'e_b'],
      diagnostic_spec: {
        schema_version: 1,
        target_error_rule_md: '把复合函数的外层导数和内层导数相加。',
        trigger_conditions_md: extra.trigger_conditions_md ?? '题目要求对复合函数求导。',
        scope_boundary_md: extra.scope_boundary_md ?? '只覆盖层间组合方式，不推断其它求导法则。',
        expected_wrong_answer_signature_md: '答案把外层导数与内层导数用加号连接。',
      },
      cause_category: 'concept_confusion',
      recurrence_count: 3,
    })}`,
  };
}

function abstainSample(
  reasonCode:
    | 'insufficient_evidence'
    | 'conflicting_evidence'
    | 'no_grounded_claim'
    | 'no_discriminating_probe' = 'insufficient_evidence',
): TaskTextResult {
  return {
    text: JSON.stringify({
      kind: 'abstain',
      reason_code: reasonCode,
      explanation_md: `abstained: ${reasonCode}`,
      evidence_event_ids: ['e_a'],
    }),
  };
}

// YUK-786 — the induction taskInput must actually CARRY the grounding packet.
// This is the "did the evidence reach the model at all" half of the acceptance
// gate; it is explicitly NOT proof that the resulting claim is grounded (that
// takes the blind review of real output — a model fed evidence will copy words
// from it and look more credible whether or not it reasoned from it).
describe('induceConjecture taskInput grounding (YUK-786)', () => {
  async function captureTaskInput(
    overrides: Partial<EnrichedEvidenceCell> = {},
  ): Promise<Record<string, unknown>> {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValue(sample('你把复合结构当成并列结构'));
    await induceConjecture({ cells: [cell(overrides)], samples: 1, runTaskFn });
    const multimodal = runTaskFn.mock.calls[0][1] as {
      text: string;
      images: Array<{ data: string; mediaType: string }>;
    };
    expect(multimodal.images).toEqual([]);
    return JSON.parse(multimodal.text) as Record<string, unknown>;
  }

  it('carries the KC name and the subject identity, not just the opaque id', async () => {
    const taskInput = await captureTaskInput();
    const cells = taskInput.evidence_cells as Array<Record<string, unknown>>;
    expect(cells).toHaveLength(1);
    expect(cells[0].knowledge_id).toBe('k_chain_rule');
    expect(cells[0].knowledge_name).toBe('链式法则');
    expect(cells[0].subject_id).toBe('math');
    expect(cells[0].subject_display_name).toBe('数学');
  });

  it('carries first-hand evidence: question prompt + learner answer + reasoning trace + cause', async () => {
    const taskInput = await captureTaskInput();
    const cells = taskInput.evidence_cells as Array<Record<string, unknown>>;
    const samples = cells[0].evidence_samples as ConjectureEvidenceSample[];
    expect(samples).toHaveLength(2);
    expect(samples[0].question_prompt_md).toContain('sin(x^2)');
    expect(samples[0].answer_md).toContain('cos(x^2)+2x');
    expect(samples[0].reasoning_trace).toContain('加起来');
    expect(samples[0].cause_category).toBe('concept_confusion');
    expect(samples[0].cause_attribution_md).toContain('复合函数');
  });

  it('attaches real images in manifest order and binds each block to its evidence source', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValue(sample('你忽略了图中的边界条件'));
    await induceConjecture({
      cells: [
        cell({
          samples: [
            evidenceSample({
              question_image_refs: ['asset_question'],
              parent_question_image_refs: ['asset_parent'],
              answer_image_refs: ['asset_answer'],
            }),
          ],
        }),
      ],
      evidenceImages: [
        {
          asset_id: 'asset_question',
          occurrences: [
            { attempt_event_id: 'e_a', source: 'question' },
            { attempt_event_id: 'e_b', source: 'answer' },
          ],
          data: 'QUESTION_BASE64',
          mediaType: 'image/png',
        },
        {
          asset_id: 'asset_parent',
          occurrences: [{ attempt_event_id: 'e_a', source: 'parent_question' }],
          data: 'PARENT_BASE64',
          mediaType: 'image/jpeg',
        },
        {
          asset_id: 'asset_answer',
          occurrences: [{ attempt_event_id: 'e_a', source: 'answer' }],
          data: 'ANSWER_BASE64',
          mediaType: 'image/webp',
        },
      ],
      samples: 1,
      runTaskFn,
    });

    const multimodal = runTaskFn.mock.calls[0][1] as {
      text: string;
      images: Array<{ data: string; mediaType: string }>;
    };
    expect(multimodal.images).toEqual([
      { data: 'QUESTION_BASE64', mediaType: 'image/png' },
      { data: 'PARENT_BASE64', mediaType: 'image/jpeg' },
      { data: 'ANSWER_BASE64', mediaType: 'image/webp' },
    ]);
    expect(JSON.parse(multimodal.text).image_manifest).toEqual([
      {
        image_index: 1,
        asset_id: 'asset_question',
        occurrences: [
          { attempt_event_id: 'e_a', source: 'question' },
          { attempt_event_id: 'e_b', source: 'answer' },
        ],
      },
      {
        image_index: 2,
        asset_id: 'asset_parent',
        occurrences: [{ attempt_event_id: 'e_a', source: 'parent_question' }],
      },
      {
        image_index: 3,
        asset_id: 'asset_answer',
        occurrences: [{ attempt_event_id: 'e_a', source: 'answer' }],
      },
    ]);
  });

  it('keeps untrusted learner text delimited on the way into the prompt', async () => {
    const taskInput = await captureTaskInput();
    const cells = taskInput.evidence_cells as Array<Record<string, unknown>>;
    const samples = cells[0].evidence_samples as ConjectureEvidenceSample[];
    for (const field of [
      samples[0].question_prompt_md,
      samples[0].answer_md,
      samples[0].reasoning_trace,
    ]) {
      expect(field).toMatch(/^<untrusted_learner_text>/);
      expect(field).toMatch(/<\/untrusted_learner_text>$/);
    }
  });

  it('passes an empty sample list through rather than dropping the key (evidence absence is signal)', async () => {
    const taskInput = await captureTaskInput({
      samples: [],
      knowledge_name: null,
      subject_id: null,
      subject_display_name: null,
    });
    const cells = taskInput.evidence_cells as Array<Record<string, unknown>>;
    expect(cells[0].evidence_samples).toEqual([]);
    expect(cells[0].knowledge_name).toBeNull();
    expect(cells[0].subject_display_name).toBeNull();
  });

  it('threads the caller subject profile into the run ctx (prompt renders in that voice)', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValue(sample('你把复合结构当成并列结构'));
    const subjectProfile = resolveSubjectProfile('yuwen');
    await induceConjecture({ cells: [cell()], samples: 1, runTaskFn, subjectProfile });
    const ctx = runTaskFn.mock.calls[0][2] as { subjectProfile?: { id: string } };
    expect(ctx.subjectProfile?.id).toBe('yuwen');
  });

  it('resolves a neutral general profile when the cell has no subject', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValue(sample('你把复合结构当成并列结构'));
    await induceConjecture({
      cells: [cell({ subject_id: null, subject_display_name: null })],
      samples: 1,
      runTaskFn,
    });
    const ctx = runTaskFn.mock.calls[0][2] as { subjectProfile?: { id?: string } };
    expect(ctx.subjectProfile?.id).toBe('general');
  });
});

describe('induceConjecture self-consistency', () => {
  it('requires 2-of-3 proposal convergence and counts abstain as a negative vote', async () => {
    const claim = '你把链式法则的层间组合误作相加';
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample(claim))
      .mockResolvedValueOnce(abstainSample())
      .mockResolvedValueOnce(sample(claim));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(proposal(result).agreement_count).toBe(2);
    expect(result.votes).toEqual({ proposal: 2, abstain: 1, invalid: 0, failed: 0 });
    expect(result.confidence).toBeCloseTo(2 / 3, 5);
  });

  it('returns no_semantic_consensus when proposal, abstain, and a different proposal split', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('claim A'))
      .mockResolvedValueOnce(abstainSample('conflicting_evidence'))
      .mockResolvedValueOnce(sample('claim B'))
      .mockResolvedValueOnce(groupResult([[0], [1]]));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(abstain(result).reason_code).toBe('no_semantic_consensus');
    expect(result.votes).toEqual({ proposal: 2, abstain: 1, invalid: 0, failed: 0 });
    expect(result.confidence).toBe(0);
  });

  it('returns the majority standard abstain reason without creating a claim', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(abstainSample('insufficient_evidence'))
      .mockResolvedValueOnce(abstainSample('conflicting_evidence'))
      .mockResolvedValueOnce(abstainSample('insufficient_evidence'));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(abstain(result)).toMatchObject({
      kind: 'abstain',
      reason_code: 'insufficient_evidence',
      evidence_event_ids: ['e_a'],
    });
    expect(result.votes).toEqual({ proposal: 0, abstain: 3, invalid: 0, failed: 0 });
  });

  it('uses the majority abstain reason when two abstentions outweigh one proposal', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('a lone proposal'))
      .mockResolvedValueOnce(abstainSample('conflicting_evidence'))
      .mockResolvedValueOnce(abstainSample('conflicting_evidence'));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(abstain(result).reason_code).toBe('conflicting_evidence');
    expect(result.votes).toEqual({ proposal: 1, abstain: 2, invalid: 0, failed: 0 });
  });

  it('counts an abstain with refs outside the quoted sample cap as invalid', async () => {
    const outsidePrompt = abstainSample('insufficient_evidence');
    const payload = JSON.parse(outsidePrompt.text) as Record<string, unknown>;
    payload.evidence_event_ids = ['e_a', 'e_unquoted'];
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValue({ text: JSON.stringify(payload) });

    const result = await induceConjecture({
      cells: [cell({ evidence_event_ids: ['e_a', 'e_b', 'e_c', 'e_unquoted'] })],
      samples: 3,
      runTaskFn,
    });

    expect(abstain(result).reason_code).toBe('invalid_output');
    expect(abstain(result).evidence_event_ids).toEqual([]);
    expect(result.votes).toEqual({ proposal: 0, abstain: 0, invalid: 3, failed: 0 });
  });

  it('uses invalid_output when invalid samples outweigh one explicit abstention', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(abstainSample('insufficient_evidence'))
      .mockResolvedValueOnce({ text: 'not json' })
      .mockResolvedValueOnce({ text: '{"kind":"proposal"}' });

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(abstain(result).reason_code).toBe('invalid_output');
    expect(abstain(result).explanation_md).toContain('structured grounding contract');
    expect(abstain(result).explanation_md).toContain('abstained: insufficient_evidence');
    expect(result.votes).toEqual({ proposal: 0, abstain: 1, invalid: 2, failed: 0 });
  });

  it('uses sample_failure when provider failures outweigh one explicit abstention', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(abstainSample('insufficient_evidence'))
      .mockRejectedValueOnce(new Error('provider timeout'))
      .mockRejectedValueOnce(new Error('provider unavailable'));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(abstain(result).reason_code).toBe('sample_failure');
    expect(abstain(result).explanation_md).toContain('valid structured decision');
    expect(abstain(result).explanation_md).toContain('abstained: insufficient_evidence');
    expect(result.votes).toEqual({ proposal: 0, abstain: 1, invalid: 0, failed: 2 });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects fabricated grounding refs as an invalid negative vote', async () => {
    const fabricated = sample('same grounded claim');
    const payload = JSON.parse(fabricated.text.slice(fabricated.text.indexOf('{'))) as Record<
      string,
      unknown
    >;
    payload.evidence_event_ids = ['invented_1', 'invented_2'];
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce({ text: JSON.stringify(payload) })
      .mockResolvedValueOnce(sample('same grounded claim'))
      .mockResolvedValueOnce(sample('same grounded claim'));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(result.outcome).toBe('proposal');
    expect(result.votes).toEqual({ proposal: 2, abstain: 0, invalid: 1, failed: 0 });
  });

  it('rejects a real cell id whose content was outside the quoted sample cap', async () => {
    const unquoted = sample('claim from unseen evidence');
    const payload = JSON.parse(unquoted.text.slice(unquoted.text.indexOf('{'))) as Record<
      string,
      unknown
    >;
    payload.evidence_event_ids = ['e_a', 'e_unquoted'];
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValue({ text: JSON.stringify(payload) });

    const result = await induceConjecture({
      cells: [
        cell({
          evidence_event_ids: ['e_a', 'e_b', 'e_c', 'e_unquoted'],
        }),
      ],
      samples: 3,
      runTaskFn,
    });

    expect(abstain(result).reason_code).toBe('invalid_output');
    expect(result.votes).toEqual({ proposal: 0, abstain: 0, invalid: 3, failed: 0 });
  });

  it('agreement across samples raises confidence; dominant claim returned with its tally + A13 fields', async () => {
    const claim = '你把链式法则当成导数相乘';
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample(claim, { predicted_p: 0.25, discriminating: true }))
      .mockResolvedValueOnce(sample(claim, { predicted_p: 0.35, discriminating: true }))
      .mockResolvedValueOnce(sample('你忘记套用幂法则'))
      // YUK-538: dominant.length=2 < drafts.length=3 → dedup fires.
      // Two claims are byte-identical (claimKey grouped them); dedup confirms [[0,1],[2]].
      .mockResolvedValueOnce(groupResult([[0, 1], [2]]));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(proposal(result).claim_md).toBe(claim); // 2 of 3 agreed → dominant
    expect(proposal(result).agreement_count).toBe(2);
    expect(proposal(result).predicted_p).toBe(0.3); // median of the dominant cluster
    expect(proposal(result).discriminating).toBe(true);
    // conjecture-wire #13 — judge gold reference flows through safeParse → draft.
    expect(proposal(result).probe_reference_md).toContain('cos(x^2)');
    expect(result.samples).toBe(3);
    expect(result.confidence).toBeCloseTo(2 / 3, 5);
    expect(result.confidence_capped).toBe(false);
    // Calls 1-3 ran on the Opus anthropic-sub lane.
    for (const call of runTaskFn.mock.calls.slice(0, 3)) {
      expect(call[0]).toBe('MindModelInductionTask');
      expect((call[2] as { override?: { provider?: string } }).override?.provider).toBe(
        'anthropic-sub',
      );
    }
    // Call 4 is ConjectureGroupingTask — no anthropic-sub override (mimo default).
    expect(runTaskFn).toHaveBeenCalledTimes(4);
    const dedupCall = runTaskFn.mock.calls[3];
    expect(dedupCall[0]).toBe('ConjectureGroupingTask');
    expect((dedupCall[2] as { override?: unknown }).override).toBeUndefined();
  });

  it('caps confidence when ALL evidence is agent-judge (no owner cause)', async () => {
    const claim = '你在不等式里读错符号';
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValue(sample(claim));

    const result = await induceConjecture({
      cells: [cell({ has_owner_cause: false })],
      samples: 3,
      runTaskFn,
    });

    expect(proposal(result).claim_md).toBe(claim);
    expect(result.confidence_capped).toBe(true);
    expect(result.confidence).toBe(0.5); // capped from raw 1.0
  });

  it('does NOT cap when at least one cell carries an owner cause', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValue(sample('你只是偶尔翻转不等号'));

    const result = await induceConjecture({
      cells: [cell({ has_owner_cause: true })],
      samples: 2,
      runTaskFn,
    });
    expect(result.confidence_capped).toBe(false);
    expect(result.confidence).toBe(1); // 2/2 agreement, uncapped
  });

  it('prefers result.structured_output over char-scanning the text', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValue({
        text: 'prose with no json braces at all',
        structured_output: {
          kind: 'proposal',
          claim_md: '你从单一例题过度泛化',
          knowledge_id: 'k_chain_rule',
          evidence_event_ids: ['e_a', 'e_b'],
          diagnostic_spec: {
            schema_version: 1,
            target_error_rule_md: '把一个例题里的局部规则用于所有相似题。',
            trigger_conditions_md: '题面表面结构与原例题相似，但关键条件不同。',
            scope_boundary_md: '不推断所有迁移任务都失败。',
            expected_wrong_answer_signature_md: '答案照搬原例题规则，忽略改变的条件。',
          },
          cause_category: 'concept_confusion',
          recurrence_count: 2,
        },
      });

    const result = await induceConjecture({ cells: [cell()], samples: 1, runTaskFn });
    expect(proposal(result).claim_md).toBe('你从单一例题过度泛化');
    expect(proposal(result).discriminating).toBe(true);
    expect(proposal(result).agreement_count).toBe(1);
  });

  it('uses an SDK-compatible object root and unwraps its draft', async () => {
    const generated = sample('你把复合函数各层导数相加');
    const draft = JSON.parse(generated.text.slice(generated.text.indexOf('{'))) as unknown;
    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, ctx: unknown) => {
      const schema = (
        ctx as {
          outputFormat: {
            schema: {
              type?: string;
              anyOf?: unknown;
              properties?: { draft?: { anyOf?: unknown } };
            };
          };
        }
      ).outputFormat.schema;
      expect(schema.type).toBe('object');
      expect(schema.anyOf).toBeUndefined();
      expect(schema.properties?.draft?.anyOf).toBeDefined();
      return { text: '', structured_output: { draft } };
    });

    const result = await induceConjecture({ cells: [cell()], samples: 1, runTaskFn });

    expect(proposal(result).claim_md).toBe('你把复合函数各层导数相加');
  });

  it('unwraps the same draft envelope from the text fallback', async () => {
    const generated = sample('你在文本降级路径中把各层导数相加');
    const draft = JSON.parse(generated.text.slice(generated.text.indexOf('{'))) as unknown;
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({ draft }),
      structured_output: undefined,
    }));

    const result = await induceConjecture({ cells: [cell()], samples: 1, runTaskFn });

    expect(proposal(result).claim_md).toBe('你在文本降级路径中把各层导数相加');
  });

  it('finds the valid JSON object after unrelated mathematical braces', async () => {
    const valid = sample('你混淆了集合与元素').text;
    const runTaskFn = vi.fn(async () => ({
      text: `推理先写集合 {x | x > 0}，这不是 JSON。\n${valid}`,
    }));

    const result = await induceConjecture({ cells: [cell()], samples: 1, runTaskFn });
    expect(proposal(result).claim_md).toBe('你混淆了集合与元素');
  });

  it('recovers when quoted prose contains an unbalanced opening brace before JSON', async () => {
    const valid = sample('你把示例文本误当成结构').text;
    const runTaskFn = vi.fn(async () => ({
      text: `推理引用了短语 "open {"，随后才输出结果。\n${valid}`,
    }));

    const result = await induceConjecture({ cells: [cell()], samples: 1, runTaskFn });
    expect(proposal(result).claim_md).toBe('你把示例文本误当成结构');
  });

  it('runs self-consistency samples concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runTaskFn = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return sample('同一个稳定结论');
    });

    await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });
    expect(maxInFlight).toBe(3);
  });

  it('returns observable invalid_output abstain when fulfilled samples contain no valid draft', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValue({ text: 'no json here, model refused' });

    const result = await induceConjecture({ cells: [cell()], samples: 2, runTaskFn });

    expect(abstain(result).reason_code).toBe('invalid_output');
    expect(result.votes).toEqual({ proposal: 0, abstain: 0, invalid: 2, failed: 0 });
    expect(result.confidence).toBe(0);
  });

  it('skips one failed induction sample and keeps requested samples as the confidence denominator', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const claim = '你把链式法则当成导数相乘';
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockRejectedValueOnce(new Error('transient sample failure'))
      .mockResolvedValueOnce({ ...sample(claim), task_run_id: 'run_2', cost_usd: 0.2 })
      .mockResolvedValueOnce({ ...sample(claim), task_run_id: 'run_3', cost_usd: 0.3 });

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(proposal(result).claim_md).toBe(claim);
    expect(proposal(result).agreement_count).toBe(2);
    expect(result.confidence).toBeCloseTo(2 / 3, 5);
    expect(result.samples).toBe(3);
    expect(result.task_run_ids).toEqual(['run_2', 'run_3', 'probe-author-run', 'probe-review-run']);
    if (result.outcome !== 'proposal') throw new Error('expected proposal');
    expect(result.primary_task_run_id).toBe('probe-author-run');
    expect(result.cost_usd).toBeCloseTo(0.5, 5);
    expect(runTaskFn).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      '[induceConjecture] induction sample failed, skipping',
      expect.objectContaining({
        sample: 1,
        requested_samples: 3,
        error: 'transient sample failure',
      }),
    );
  });

  it('uses a winning proposal sample for scalar task-run correlation', async () => {
    const claim = '你把链式法则当成导数相加';
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce({
        ...abstainSample('insufficient_evidence'),
        task_run_id: 'run_abstain',
      })
      .mockResolvedValueOnce({ ...sample(claim), task_run_id: 'run_winner_1' })
      .mockResolvedValueOnce({ ...sample(claim), task_run_id: 'run_winner_2' });

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(result.outcome).toBe('proposal');
    if (result.outcome !== 'proposal') throw new Error('expected proposal');
    expect(result.primary_task_run_id).toBe('probe-author-run');
    expect(result.task_run_ids).toEqual([
      'run_abstain',
      'run_winner_1',
      'run_winner_2',
      'probe-author-run',
      'probe-review-run',
    ]);
  });

  it('still fails closed when every induction sample throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnSpy.mockClear();
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockRejectedValue(new Error('provider unavailable'));

    await expect(induceConjecture({ cells: [cell()], samples: 2, runTaskFn })).rejects.toThrow(
      /every induction sample failed.*provider unavailable/,
    );

    expect(runTaskFn).toHaveBeenCalledTimes(2);
    expect(
      warnSpy.mock.calls.filter(
        ([message]) => message === '[induceConjecture] induction sample failed, skipping',
      ),
    ).toHaveLength(2);
  });

  // YUK-538 — new tests for semantic dedup (ConjectureGroupingTask)

  it('dedup: three paraphrase claims → confidence 1.0, agreement_count 3', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(
        sample('你把链式法则当成导数相乘', { predicted_p: 0.25, discriminating: true }),
      )
      .mockResolvedValueOnce(
        sample('你误以为链式法则就是把各层导数相乘', { predicted_p: 0.3, discriminating: true }),
      )
      .mockResolvedValueOnce(
        sample('你认为链式法则等价于将每层求导结果连乘', {
          predicted_p: 0.28,
          discriminating: true,
        }),
      )
      .mockResolvedValueOnce(groupResult([[0, 1, 2]]));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(proposal(result).agreement_count).toBe(3);
    expect(result.confidence).toBeCloseTo(1.0, 5);
    expect(result.confidence_capped).toBe(false);
    expect(runTaskFn).toHaveBeenCalledTimes(4);
    // Calls 1-3: MindModelInductionTask on anthropic-sub.
    for (const call of runTaskFn.mock.calls.slice(0, 3)) {
      expect(call[0]).toBe('MindModelInductionTask');
      expect((call[2] as { override?: { provider?: string } }).override?.provider).toBe(
        'anthropic-sub',
      );
    }
    // Call 4: ConjectureGroupingTask — no anthropic-sub override (mimo default).
    const dedupCall = runTaskFn.mock.calls[3];
    expect(dedupCall[0]).toBe('ConjectureGroupingTask');
    expect((dedupCall[2] as { override?: unknown }).override).toBeUndefined();
    expect((dedupCall[1] as { hypotheses: unknown[] }).hypotheses).toHaveLength(3);
  });

  it('dedup: 2-of-3 semantic agreement → confidence 0.667, agreement_count 2', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('你把链式法则当成导数相乘'))
      .mockResolvedValueOnce(sample('你误以为链式法则就是把各层导数相乘'))
      .mockResolvedValueOnce(sample('你忘记套用幂法则'))
      .mockResolvedValueOnce(groupResult([[0, 1], [2]]));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(proposal(result).agreement_count).toBe(2);
    expect(result.confidence).toBeCloseTo(2 / 3, 5);
    expect(runTaskFn).toHaveBeenCalledTimes(4);
  });

  it('uses a deterministic representative only for claim/spec, then authors probes separately', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(
        sample('zeta claim', {
          predicted_p: 0.8,
          discriminating: true,
          probe_md: 'z probe',
          probe_reference_md: 'z reference',
        }),
      )
      .mockResolvedValueOnce(
        sample('alpha claim', {
          predicted_p: 0.2,
          discriminating: false,
          probe_md: 'a probe',
          probe_reference_md: 'a reference',
        }),
      )
      .mockResolvedValueOnce(groupResult([[0, 1]]));

    const result = await induceConjecture({ cells: [cell()], samples: 2, runTaskFn });

    expect(proposal(result).claim_md).toBe('alpha claim');
    expect(proposal(result).probe_md).toBe("对 f(x)=sin(x^2)，写出 f'(x)。");
    expect(proposal(result).probe_md).not.toBe('a probe');
    expect(proposal(result).predicted_p).toBe(0.3);
    expect(proposal(result).discriminating).toBe(true);
  });

  it('never selects a probe tuple from a semantic claim cluster', async () => {
    const pairs = [
      ['a probe', 'x reference'],
      ['a probe', 'y reference'],
      ['b probe', 'z reference'],
      ['c probe', 'z reference'],
    ] as const;
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(
        sample('same semantic claim one', {
          probe_md: pairs[0][0],
          probe_reference_md: pairs[0][1],
        }),
      )
      .mockResolvedValueOnce(
        sample('same semantic claim two', {
          probe_md: pairs[1][0],
          probe_reference_md: pairs[1][1],
        }),
      )
      .mockResolvedValueOnce(
        sample('same semantic claim three', {
          probe_md: pairs[2][0],
          probe_reference_md: pairs[2][1],
        }),
      )
      .mockResolvedValueOnce(
        sample('same semantic claim four', {
          probe_md: pairs[3][0],
          probe_reference_md: pairs[3][1],
        }),
      )
      .mockResolvedValueOnce(groupResult([[0, 1, 2, 3]]));

    const result = await induceConjecture({ cells: [cell()], samples: 4, runTaskFn });

    expect(proposal(result).claim_md).toBe('same semantic claim four');
    expect(pairs.flat()).not.toContain(proposal(result).probe_md);
    expect(proposal(result).probe_quality.passed).toBe(true);
  });

  it('chooses the majority claim/spec but not its old probe tuple', async () => {
    const majority = {
      probe_md: 'z majority probe',
      probe_reference_md: 'z majority reference',
    };
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('z majority claim', majority))
      .mockResolvedValueOnce(sample('z majority claim', majority))
      .mockResolvedValueOnce(
        sample('a lexical outlier', {
          probe_md: 'a outlier probe',
          probe_reference_md: 'a outlier reference',
        }),
      )
      .mockResolvedValueOnce(groupResult([[0, 1, 2]]));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(proposal(result).claim_md).toBe('z majority claim');
    expect(proposal(result).probe_md).not.toBe(majority.probe_md);
    expect(proposal(result).probe_md).toBe("对 f(x)=sin(x^2)，写出 f'(x)。");
    expect(proposal(result).agreement_count).toBe(3);
  });

  it('fails closed when equal-sized semantic groups tie', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('zeta claim'))
      .mockResolvedValueOnce(sample('alpha claim'))
      .mockResolvedValueOnce(groupResult([[0], [1]]));

    const result = await induceConjecture({ cells: [cell()], samples: 2, runTaskFn });
    expect(abstain(result).reason_code).toBe('no_semantic_consensus');
    expect(result.confidence).toBe(0);
  });

  it('dedup not called when all samples are byte-identical (claimKey unanimous)', async () => {
    const claim = '你把链式法则当成导数相乘';
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample(claim, { predicted_p: 0.25 }))
      .mockResolvedValueOnce(sample(claim, { predicted_p: 0.35 }))
      .mockResolvedValueOnce(sample(claim, { predicted_p: 0.3 }));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(runTaskFn).toHaveBeenCalledTimes(3); // No dedup call
    expect(proposal(result).agreement_count).toBe(3);
    expect(result.confidence).toBeCloseTo(1.0, 5);
  });

  it('preserves an exact 2-of-3 quorum when ConjectureGroupingTask is unparseable', async () => {
    const exact = '你把链式法则当成导数相乘';
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample(exact))
      .mockResolvedValueOnce(sample(exact))
      .mockResolvedValueOnce(sample('完全不同的主张'))
      .mockResolvedValueOnce({ text: 'sorry, I cannot help', structured_output: undefined });

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(proposal(result).claim_md).toBe(exact);
    expect(proposal(result).agreement_count).toBe(2);
    expect(result.confidence).toBeCloseTo(2 / 3, 5);
    expect(runTaskFn).toHaveBeenCalledTimes(4);
  });

  it('fails operationally when semantic grouping is load-bearing and throws', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('你把链式法则当成导数相乘'))
      .mockResolvedValueOnce(sample('你误以为链式法则就是把各层导数相乘'))
      .mockResolvedValueOnce(sample('你认为链式法则等价于将每层求导结果连乘'))
      .mockRejectedValueOnce(new Error('AuthenticationError'));

    await expect(
      induceConjecture({ cells: [cell()], samples: 3, runTaskFn }),
    ).rejects.toMatchObject({
      name: 'ConjectureInductionOperationalError',
      taskKind: 'ConjectureGroupingTask',
      message: expect.stringContaining('ConjectureGroupingTask failed before semantic consensus'),
    } satisfies Partial<ConjectureInductionOperationalError>);
    expect(runTaskFn).toHaveBeenCalledTimes(4);
  });

  it('confidence_capped applies after dedup-elevated confidence', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('你把链式法则当成导数相乘'))
      .mockResolvedValueOnce(sample('你误以为链式法则就是把各层导数相乘'))
      .mockResolvedValueOnce(sample('你认为链式法则等价于将每层求导结果连乘'))
      .mockResolvedValueOnce(groupResult([[0, 1, 2]]));

    const result = await induceConjecture({
      cells: [cell({ has_owner_cause: false })],
      samples: 3,
      runTaskFn,
    });

    expect(result.confidence).toBe(0.5); // capped from raw 1.0
    expect(result.confidence_capped).toBe(true);
  });

  it('dedup fires when 1 of 3 samples fails to parse and the 2 survivors are distinct', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('你把链式法则当成导数相乘'))
      .mockResolvedValueOnce({ text: 'no json here, model refused' }) // parse fail
      .mockResolvedValueOnce(sample('你误以为链式法则就是把各层导数相乘'))
      .mockResolvedValueOnce(groupResult([[0, 1]])); // dedup call sees 2 survivors

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    // Dedup fired with 2 claims and returned them as equivalent.
    expect(proposal(result).agreement_count).toBe(2);
    // confidence denominator is samples=3 (parse failure is non-agreement).
    expect(result.confidence).toBeCloseTo(2 / 3, 5);
    expect(runTaskFn).toHaveBeenCalledTimes(4);
    const dedupCall = runTaskFn.mock.calls[3];
    expect((dedupCall[1] as { hypotheses: unknown[] }).hypotheses).toHaveLength(2);
  });

  it('dedup fails operationally when LLM returns extra indices (flat count > N)', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('A'))
      .mockResolvedValueOnce(sample('B'))
      .mockResolvedValueOnce(sample('C'))
      .mockResolvedValueOnce(
        groupResult([
          [0, 1, 2],
          [1, 2],
        ]),
      ); // flat count=5 ≠ N=3 → partition invalid

    await expect(induceConjecture({ cells: [cell()], samples: 3, runTaskFn })).rejects.toThrow(
      'ConjectureGroupingTask failed before semantic consensus',
    );
  });

  it('dedup fails operationally on in-range duplicate indices', async () => {
    // [[0, 0], [1]] has flat length 3 = N=3 but index 0 is duplicated and index 2 missing.
    // The old flat-length guard missed this; the partition check catches it.
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('A'))
      .mockResolvedValueOnce(sample('B'))
      .mockResolvedValueOnce(sample('C'))
      .mockResolvedValueOnce(groupResult([[0, 0], [1]])); // flat=[0,0,1], length=3=N but 0 duplicated, 2 missing

    await expect(induceConjecture({ cells: [cell()], samples: 3, runTaskFn })).rejects.toThrow(
      'ConjectureGroupingTask failed before semantic consensus',
    );
    expect(runTaskFn).toHaveBeenCalledTimes(4); // 3 induction + 1 dedup
  });

  it('requires semantic consensus on the frozen DiagnosticSpec, not claim text alone', async () => {
    const claim = '你在速率换算时没有完成分母时间单位转换';
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(
        sample(claim, { trigger_conditions_md: '目标分母时间单位与源单位不同。' }),
      )
      .mockResolvedValueOnce(sample(claim, { trigger_conditions_md: '任何复合单位换算。' }))
      .mockResolvedValueOnce(groupResult([[0], [1]]));

    const result = await induceConjecture({ cells: [cell()], samples: 2, runTaskFn });

    expect(abstain(result).reason_code).toBe('no_semantic_consensus');
    expect(runTaskFn.mock.calls[2][0]).toBe('ConjectureGroupingTask');
  });

  it('regenerates the whole pair once after an independent review failure, then persists audit', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('你把复合函数各层导数相加'))
      .mockResolvedValueOnce(probePackageResult({ taskRunId: 'author_1' }))
      .mockResolvedValueOnce(probeReviewResult('fail', ['probe_not_targeting'], 'review_1'))
      .mockResolvedValueOnce(
        probePackageResult({
          primaryPrompt: '对 y=sin(x³) 求导。',
          followupPrompt: '速度由 cos(t²) 给出，用文字说明瞬时变化率。',
          taskRunId: 'author_2',
        }),
      )
      .mockResolvedValueOnce(probeReviewResult('pass', [], 'review_2'));

    const result = await induceConjectureImpl({
      cells: [cell()],
      samples: 1,
      runTaskFn,
    });

    const draft = proposal(result);
    expect(draft.probe_md).toBe('对 y=sin(x³) 求导。');
    expect(draft.probe_quality.schema_version).toBe(4);
    expect(draft.probe_quality).toMatchObject({
      reviewed_hypothesis: {
        kind: 'proposal',
        claim_md: draft.claim_md,
        knowledge_id: draft.knowledge_id,
        evidence_event_ids: draft.evidence_event_ids,
        diagnostic_spec: draft.diagnostic_spec,
        cause_category: draft.cause_category,
        recurrence_count: draft.recurrence_count,
      },
      reviewed_package: {
        primary: draft.probe_spec,
        followup: draft.followup_probe_spec,
        predicted_p: draft.predicted_p,
      },
    });
    if (draft.probe_quality.schema_version !== 4) throw new Error('expected v4 audit');
    expect(draft.probe_quality.reviewed_hypothesis).not.toBe(draft);
    expect(draft.probe_quality.reviewed_package.primary).not.toBe(draft.probe_spec);
    expect(draft.probe_quality.attempts).toMatchObject([
      {
        attempt: 1,
        outcome: 'review_failed',
        failure_codes: ['probe_not_targeting'],
        author_task_run_id: 'author_1',
        reviewer_task_run_id: 'review_1',
      },
      {
        attempt: 2,
        outcome: 'passed',
        failure_codes: [],
        author_task_run_id: 'author_2',
        reviewer_task_run_id: 'review_2',
      },
    ]);
    expect(result.outcome).toBe('proposal');
    if (result.outcome !== 'proposal') throw new Error('expected proposal');
    expect(result.probe_quality_attempts).not.toBe(draft.probe_quality.attempts);
    expect(result.probe_quality_attempts[0]?.failure_codes).not.toBe(
      draft.probe_quality.attempts[0]?.failure_codes,
    );
    expect(result.primary_task_run_id).toBe('author_2');
    expect(
      runTaskFn.mock.calls
        .slice(1)
        .map(([kind, , ctx]) => [
          kind,
          (ctx as { override?: { provider?: string } }).override?.provider,
        ]),
    ).toEqual([
      ['ConjectureProbeAuthorTask', 'anthropic-sub'],
      ['ConjectureProbeReviewTask', 'anthropic-sub'],
      ['ConjectureProbeAuthorTask', 'anthropic-sub'],
      ['ConjectureProbeReviewTask', 'anthropic-sub'],
    ]);
  });

  it('fails closed after two structurally non-independent pairs without invoking reviewer', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('你把复合函数各层导数相加'))
      .mockResolvedValueOnce(probePackageResult({ samePresentation: true, taskRunId: 'author_1' }))
      .mockResolvedValueOnce(probePackageResult({ samePresentation: true, taskRunId: 'author_2' }));

    const result = await induceConjectureImpl({
      cells: [cell()],
      samples: 1,
      runTaskFn,
    });

    expect(abstain(result).reason_code).toBe('no_discriminating_probe');
    expect(result.probe_quality_attempts).toHaveLength(2);
    expect(
      result.probe_quality_attempts.every((attempt) =>
        attempt.outcome === 'structure_failed'
          ? attempt.failure_codes.includes('probe_pair_not_independent')
          : false,
      ),
    ).toBe(true);
    expect(runTaskFn.mock.calls.map(([kind]) => kind)).toEqual([
      'MindModelInductionTask',
      'ConjectureProbeAuthorTask',
      'ConjectureProbeAuthorTask',
    ]);
  });

  it('runs deterministic subject validators before review and regenerates the whole pair once', async () => {
    process.env.SUBJECT_PROBE_VALIDATORS_BLOCKING_ENABLED = 'true';
    try {
      const runTaskFn = vi
        .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
        .mockResolvedValueOnce(unitSample())
        .mockResolvedValueOnce(
          unitProbePackageResult({ taskRunId: 'unit_author_1', primaryGold: '21 m/s' }),
        )
        .mockResolvedValueOnce(unitProbePackageResult({ taskRunId: 'unit_author_2' }))
        .mockResolvedValueOnce(probeReviewResult('pass', [], 'unit_review_2'));

      const result = await induceConjectureImpl({
        cells: [unitCell()],
        samples: 1,
        runTaskFn,
        subjectProfile: resolveSubjectProfile('math'),
      });

      const draft = proposal(result);
      expect(draft.probe_quality).toMatchObject({
        schema_version: 4,
        subject_id: 'math',
        policy_version: 'subject-probe-validator-v1',
        attempts: [
          {
            attempt: 1,
            outcome: 'subject_validator_failed',
            failure_codes: ['unit_reference_mismatch'],
            reviewer_task_run_id: null,
          },
          { attempt: 2, outcome: 'passed', reviewer_task_run_id: 'unit_review_2' },
        ],
        subject_validator_results: expect.arrayContaining([
          expect.objectContaining({
            validator_id: 'math.compound-unit-denominator-conversion',
            outcome: 'pass',
          }),
        ]),
      });
      expect(runTaskFn.mock.calls.map(([kind]) => kind)).toEqual([
        'MindModelInductionTask',
        'ConjectureProbeAuthorTask',
        'ConjectureProbeAuthorTask',
        'ConjectureProbeReviewTask',
      ]);
    } finally {
      // biome-ignore lint/performance/noDelete: test isolation needs a real unset.
      delete process.env.SUBJECT_PROBE_VALIDATORS_BLOCKING_ENABLED;
    }
  });

  it('abstains after two deterministic subject failures without spending reviewer calls', async () => {
    process.env.SUBJECT_PROBE_VALIDATORS_BLOCKING_ENABLED = 'true';
    try {
      const runTaskFn = vi
        .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
        .mockResolvedValueOnce(unitSample())
        .mockResolvedValueOnce(
          unitProbePackageResult({ taskRunId: 'unit_author_1', primaryGold: '21 m/s' }),
        )
        .mockResolvedValueOnce(
          unitProbePackageResult({ taskRunId: 'unit_author_2', primaryGold: '22 m/s' }),
        );

      const result = await induceConjectureImpl({
        cells: [unitCell()],
        samples: 1,
        runTaskFn,
        subjectProfile: resolveSubjectProfile('math'),
      });

      expect(abstain(result).reason_code).toBe('no_discriminating_probe');
      expect(result.probe_quality_attempts.map((attempt) => attempt.outcome)).toEqual([
        'subject_validator_failed',
        'subject_validator_failed',
      ]);
      expect(runTaskFn.mock.calls.map(([kind]) => kind)).toEqual([
        'MindModelInductionTask',
        'ConjectureProbeAuthorTask',
        'ConjectureProbeAuthorTask',
      ]);
    } finally {
      // biome-ignore lint/performance/noDelete: test isolation needs a real unset.
      delete process.env.SUBJECT_PROBE_VALIDATORS_BLOCKING_ENABLED;
    }
  });

  it('persists deterministic disagreement in shadow mode without replacing the P0 decision', async () => {
    // biome-ignore lint/performance/noDelete: shadow is the real unset/default state.
    delete process.env.SUBJECT_PROBE_VALIDATORS_BLOCKING_ENABLED;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const runTaskFn = vi
        .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
        .mockResolvedValueOnce(unitSample())
        .mockResolvedValueOnce(
          unitProbePackageResult({ taskRunId: 'unit_shadow_author', primaryGold: '21 m/s' }),
        )
        .mockResolvedValueOnce(probeReviewResult('pass', [], 'unit_shadow_review'));

      const draft = proposal(
        await induceConjectureImpl({
          cells: [unitCell()],
          samples: 1,
          runTaskFn,
          subjectProfile: resolveSubjectProfile('math'),
        }),
      );
      if (draft.probe_quality.schema_version !== 4) throw new Error('expected v4 audit');
      expect(draft.probe_quality.subject_validator_results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            validator_id: 'math.compound-unit-denominator-conversion',
            outcome: 'fail',
            failure_codes: ['unit_reference_mismatch'],
          }),
        ]),
      );
      expect(warn).toHaveBeenCalledWith(
        '[conjecture-probe-quality] shadow subject validator disagreement',
        expect.objectContaining({ subject_id: 'math' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps shadow disagreement evidence when the reviewer rejects that package', async () => {
    // biome-ignore lint/performance/noDelete: shadow is the real unset/default state.
    delete process.env.SUBJECT_PROBE_VALIDATORS_BLOCKING_ENABLED;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const runTaskFn = vi
        .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
        .mockResolvedValueOnce(unitSample())
        .mockResolvedValueOnce(
          unitProbePackageResult({ taskRunId: 'unit_shadow_author_1', primaryGold: '21 m/s' }),
        )
        .mockResolvedValueOnce(
          probeReviewResult('fail', ['reference_incorrect'], 'unit_shadow_review_1'),
        )
        .mockResolvedValueOnce(unitProbePackageResult({ taskRunId: 'unit_shadow_author_2' }))
        .mockResolvedValueOnce(probeReviewResult('pass', [], 'unit_shadow_review_2'));

      const draft = proposal(
        await induceConjectureImpl({
          cells: [unitCell()],
          samples: 1,
          runTaskFn,
          subjectProfile: resolveSubjectProfile('math'),
        }),
      );
      const firstAttempt = draft.probe_quality.attempts[0];
      expect(firstAttempt).toMatchObject({
        outcome: 'review_failed',
        subject_validator_results: expect.arrayContaining([
          expect.objectContaining({
            validator_id: 'math.compound-unit-denominator-conversion',
            outcome: 'fail',
            failure_codes: ['unit_reference_mismatch'],
          }),
        ]),
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('regenerates a bare single-choice probe whose target rule only forces a random guess', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('你把使动与意动的判据混为一谈'))
      .mockResolvedValueOnce(
        probePackageResult({ bareAmbiguousSingleChoice: true, taskRunId: 'author_1' }),
      )
      .mockResolvedValueOnce(probePackageResult({ taskRunId: 'author_2' }))
      .mockResolvedValueOnce(probeReviewResult('pass', [], 'review_2'));

    const result = await induceConjectureImpl({
      cells: [cell({ subject_id: 'yuwen', subject_display_name: '语文' })],
      samples: 1,
      runTaskFn,
    });

    const draft = proposal(result);
    expect(draft.probe_quality.attempts[0]).toMatchObject({
      attempt: 1,
      outcome: 'operational_failed',
      failure_codes: ['author_output_invalid'],
      author_task_run_id: 'author_1',
      reviewer_task_run_id: null,
    });
    expect(draft.probe_quality.attempts[1]).toMatchObject({
      attempt: 2,
      outcome: 'passed',
      author_task_run_id: 'author_2',
      reviewer_task_run_id: 'review_2',
    });
  });

  it('preserves terminal reviewer failures and shadow results on the operational error', async () => {
    // biome-ignore lint/performance/noDelete: shadow is the real unset/default state.
    delete process.env.SUBJECT_PROBE_VALIDATORS_BLOCKING_ENABLED;
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(unitSample())
      .mockResolvedValueOnce(
        unitProbePackageResult({ taskRunId: 'author_1', primaryGold: '21 m/s' }),
      )
      .mockRejectedValueOnce(new Error('review timeout'))
      .mockResolvedValueOnce(
        unitProbePackageResult({ taskRunId: 'author_2', primaryGold: '22 m/s' }),
      )
      .mockRejectedValueOnce(new Error('review timeout'));

    await expect(
      induceConjectureImpl({
        cells: [unitCell()],
        samples: 1,
        runTaskFn,
        subjectProfile: resolveSubjectProfile('math'),
      }),
    ).rejects.toMatchObject({
      name: 'ConjectureInductionOperationalError',
      taskKind: 'ConjectureProbeReviewTask',
      probe_quality_attempts: [
        {
          attempt: 1,
          outcome: 'operational_failed',
          subject_validator_results: expect.arrayContaining([
            expect.objectContaining({
              validator_id: 'math.compound-unit-denominator-conversion',
              outcome: 'fail',
              failure_codes: ['unit_reference_mismatch'],
            }),
          ]),
        },
        {
          attempt: 2,
          outcome: 'operational_failed',
          subject_validator_results: expect.arrayContaining([
            expect.objectContaining({
              validator_id: 'math.compound-unit-denominator-conversion',
              outcome: 'fail',
              failure_codes: ['unit_reference_mismatch'],
            }),
          ]),
        },
      ],
    });
  });

  it('treats missing author task-run lineage as an operational failure', async () => {
    const authorWithoutLineage = {
      ...probePackageResult(),
      task_run_id: undefined,
    };
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('你把复合函数各层导数相加'))
      .mockResolvedValueOnce(authorWithoutLineage)
      .mockResolvedValueOnce(authorWithoutLineage);

    await expect(
      induceConjectureImpl({ cells: [cell()], samples: 1, runTaskFn }),
    ).rejects.toMatchObject({
      name: 'ConjectureInductionOperationalError',
      taskKind: 'ConjectureProbeAuthorTask',
      message: expect.stringContaining('task-run lineage'),
    });
    expect(runTaskFn.mock.calls.map(([kind]) => kind)).toEqual([
      'MindModelInductionTask',
      'ConjectureProbeAuthorTask',
      'ConjectureProbeAuthorTask',
    ]);
  });

  it('does not count a reviewer outage plus one semantic failure as two quality votes', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('你把复合函数各层导数相加'))
      .mockResolvedValueOnce(probePackageResult({ taskRunId: 'author_1' }))
      .mockRejectedValueOnce(new Error('review timeout'))
      .mockResolvedValueOnce(probePackageResult({ taskRunId: 'author_2' }))
      .mockResolvedValueOnce(probeReviewResult('fail', ['probe_not_targeting'], 'review_2'));

    await expect(
      induceConjectureImpl({ cells: [cell()], samples: 1, runTaskFn }),
    ).rejects.toMatchObject({
      name: 'ConjectureInductionOperationalError',
      taskKind: 'ConjectureProbeReviewTask',
      message: expect.stringContaining('operational failure'),
    });
  });
});
