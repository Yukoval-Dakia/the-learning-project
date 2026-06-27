// YUK-406 Phase 0 / YUK-440 A13 — induceConjecture orchestrator unit tests
// (pure: injected runTaskFn, no DB / AI / R2).

import type { TaskTextResult } from '@/server/ai/provenance';
import type { EvidenceCell } from '@/server/conjectures/evidence';
import { describe, expect, it, vi } from 'vitest';

import { induceConjecture } from './induce';

function cell(overrides: Partial<EvidenceCell> = {}): EvidenceCell {
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
    ...overrides,
  };
}

function sample(
  claim: string,
  extra: { predicted_p?: number; discriminating?: boolean } = {},
): TaskTextResult {
  return {
    text: `reasoning...\n${JSON.stringify({
      claim_md: claim,
      probe_md: "对 f(x)=sin(x^2)，写出 f'(x) 并说明用到链式法则的哪一层。",
      cause_category: 'concept_confusion',
      recurrence_count: 3,
      predicted_p: extra.predicted_p ?? 0.3,
      discriminating: extra.discriminating ?? true,
      agreement_count: 1,
    })}`,
  };
}

describe('induceConjecture self-consistency', () => {
  it('agreement across samples raises confidence; dominant claim returned with its tally + A13 fields', async () => {
    const claim = '你把链式法则当成导数相乘';
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample(claim, { predicted_p: 0.25, discriminating: true }))
      .mockResolvedValueOnce(sample(claim, { predicted_p: 0.35, discriminating: true }))
      .mockResolvedValueOnce(sample('你忘记套用幂法则'));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(result.draft.claim_md).toBe(claim); // 2 of 3 agreed → dominant
    expect(result.draft.agreement_count).toBe(2);
    expect(result.draft.predicted_p).toBe(0.25); // dominant representative (first in cluster)
    expect(result.draft.discriminating).toBe(true);
    expect(result.samples).toBe(3);
    expect(result.confidence).toBeCloseTo(2 / 3, 5);
    expect(result.confidence_capped).toBe(false);
    // It ran on the Opus anthropic-sub lane for every sample.
    for (const call of runTaskFn.mock.calls) {
      expect(call[0]).toBe('MindModelInductionTask');
      expect((call[2] as { override?: { provider?: string } }).override?.provider).toBe(
        'anthropic-sub',
      );
    }
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

    expect(result.draft.claim_md).toBe(claim);
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
          claim_md: '你从单一例题过度泛化',
          probe_md: '这是例题没覆盖的新情形，请预测。',
          cause_category: 'concept_confusion',
          recurrence_count: 2,
          predicted_p: 0.4,
          discriminating: false,
          agreement_count: 1,
        },
      });

    const result = await induceConjecture({ cells: [cell()], samples: 1, runTaskFn });
    expect(result.draft.claim_md).toBe('你从单一例题过度泛化');
    expect(result.draft.discriminating).toBe(false);
    expect(result.draft.agreement_count).toBe(1);
  });

  it('throws when no sample produces a valid ConjectureDraft (anti-fabrication)', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValue({ text: 'no json here, model refused' });

    await expect(induceConjecture({ cells: [cell()], samples: 2, runTaskFn })).rejects.toThrow(
      /no sample produced a valid ConjectureDraft/,
    );
  });
});
