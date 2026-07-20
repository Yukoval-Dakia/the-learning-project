// YUK-406 Phase 0 / YUK-440 A13 — induceConjecture orchestrator unit tests
// (pure: injected runTaskFn, no DB / AI / R2).

import type { TaskTextResult } from '@/server/ai/provenance';
import type { EvidenceCell } from '@/server/conjectures/evidence';
import { describe, expect, it, vi } from 'vitest';

import { induceConjecture } from './induce';

/** Helper: produces a TaskTextResult carrying a ClaimGroupingTask structured_output. */
function groupResult(groups: number[][]): TaskTextResult {
  return { text: '', structured_output: { groups } };
}

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
  extra: {
    predicted_p?: number;
    discriminating?: boolean;
    probe_md?: string;
    probe_reference_md?: string;
  } = {},
): TaskTextResult {
  return {
    text: `reasoning...\n${JSON.stringify({
      claim_md: claim,
      probe_md: extra.probe_md ?? "对 f(x)=sin(x^2)，写出 f'(x) 并说明用到链式法则的哪一层。",
      // conjecture-wire #13 — judge gold reference (single-writer, produced with probe).
      probe_reference_md:
        extra.probe_reference_md ??
        "f'(x)=2x·cos(x^2)；外层 cos·内层 2x（链式法则：外导 × 内导）。",
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
      .mockResolvedValueOnce(sample('你忘记套用幂法则'))
      // YUK-538: dominant.length=2 < drafts.length=3 → dedup fires.
      // Two claims are byte-identical (claimKey grouped them); dedup confirms [[0,1],[2]].
      .mockResolvedValueOnce(groupResult([[0, 1], [2]]));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(result.draft.claim_md).toBe(claim); // 2 of 3 agreed → dominant
    expect(result.draft.agreement_count).toBe(2);
    expect(result.draft.predicted_p).toBe(0.3); // median of the dominant cluster
    expect(result.draft.discriminating).toBe(true);
    // conjecture-wire #13 — judge gold reference flows through safeParse → draft.
    expect(result.draft.probe_reference_md).toContain('cos(x^2)');
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
    // Call 4 is ClaimGroupingTask — no anthropic-sub override (mimo default).
    expect(runTaskFn).toHaveBeenCalledTimes(4);
    const dedupCall = runTaskFn.mock.calls[3];
    expect(dedupCall[0]).toBe('ClaimGroupingTask');
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
          probe_reference_md: '对新情形应用原例题的泛化规则，给出预测值与依据。',
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

  it('finds the valid JSON object after unrelated mathematical braces', async () => {
    const valid = sample('你混淆了集合与元素').text;
    const runTaskFn = vi.fn(async () => ({
      text: `推理先写集合 {x | x > 0}，这不是 JSON。\n${valid}`,
    }));

    const result = await induceConjecture({ cells: [cell()], samples: 1, runTaskFn });
    expect(result.draft.claim_md).toBe('你混淆了集合与元素');
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

  it('throws when no sample produces a valid ConjectureDraft (anti-fabrication)', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValue({ text: 'no json here, model refused' });

    await expect(induceConjecture({ cells: [cell()], samples: 2, runTaskFn })).rejects.toThrow(
      /no sample produced a valid ConjectureDraft/,
    );
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

    expect(result.draft.claim_md).toBe(claim);
    expect(result.draft.agreement_count).toBe(2);
    expect(result.confidence).toBeCloseTo(2 / 3, 5);
    expect(result.samples).toBe(3);
    expect(result.task_run_ids).toEqual(['run_2', 'run_3']);
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

  it('still fails closed when every induction sample throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnSpy.mockClear();
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockRejectedValue(new Error('provider unavailable'));

    await expect(induceConjecture({ cells: [cell()], samples: 2, runTaskFn })).rejects.toThrow(
      /no sample produced a valid ConjectureDraft.*provider unavailable/,
    );

    expect(runTaskFn).toHaveBeenCalledTimes(2);
    expect(
      warnSpy.mock.calls.filter(
        ([message]) => message === '[induceConjecture] induction sample failed, skipping',
      ),
    ).toHaveLength(2);
  });

  // YUK-538 — new tests for semantic dedup (ClaimGroupingTask)

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

    expect(result.draft.agreement_count).toBe(3);
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
    // Call 4: ClaimGroupingTask — no anthropic-sub override (mimo default).
    const dedupCall = runTaskFn.mock.calls[3];
    expect(dedupCall[0]).toBe('ClaimGroupingTask');
    expect((dedupCall[2] as { override?: unknown }).override).toBeUndefined();
    expect((dedupCall[1] as { claims: string[] }).claims).toHaveLength(3);
  });

  it('dedup: 2-of-3 semantic agreement → confidence 0.667, agreement_count 2', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('你把链式法则当成导数相乘'))
      .mockResolvedValueOnce(sample('你误以为链式法则就是把各层导数相乘'))
      .mockResolvedValueOnce(sample('你忘记套用幂法则'))
      .mockResolvedValueOnce(groupResult([[0, 1], [2]]));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(result.draft.agreement_count).toBe(2);
    expect(result.confidence).toBeCloseTo(2 / 3, 5);
    expect(runTaskFn).toHaveBeenCalledTimes(4);
  });

  it('uses lexical cluster tie-breaks and aggregates winning fields deterministically', async () => {
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

    expect(result.draft.claim_md).toBe('alpha claim');
    expect(result.draft.probe_md).toBe('a probe');
    expect(result.draft.probe_reference_md).toBe('a reference');
    expect(result.draft.predicted_p).toBe(0.5);
    expect(result.draft.discriminating).toBe(false);
  });

  it('keeps each probe paired with the gold reference generated in the same sample', async () => {
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

    // Independent field modes would synthesize the nonexistent pair (a probe, z reference).
    expect([result.draft.probe_md, result.draft.probe_reference_md]).toEqual(pairs[0]);
    expect(pairs).toContainEqual([result.draft.probe_md, result.draft.probe_reference_md]);
  });

  it('chooses the lexical claim when equal-sized semantic groups tie', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('zeta claim'))
      .mockResolvedValueOnce(sample('alpha claim'))
      .mockResolvedValueOnce(groupResult([[0], [1]]));

    const result = await induceConjecture({ cells: [cell()], samples: 2, runTaskFn });
    expect(result.draft.claim_md).toBe('alpha claim');
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
    expect(result.draft.agreement_count).toBe(3);
    expect(result.confidence).toBeCloseTo(1.0, 5);
  });

  it('dedup degrades gracefully when ClaimGroupingTask returns unparseable output', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('你把链式法则当成导数相乘'))
      .mockResolvedValueOnce(sample('你误以为链式法则就是把各层导数相乘'))
      .mockResolvedValueOnce(sample('你认为链式法则等价于将每层求导结果连乘'))
      .mockResolvedValueOnce({ text: 'sorry, I cannot help', structured_output: undefined });

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    // Falls back to claimKey singletons — confidence stays 1/3, no throw.
    expect(result.confidence).toBeCloseTo(1 / 3, 5);
    expect(result.draft.agreement_count).toBe(1);
    expect(runTaskFn).toHaveBeenCalledTimes(4);
  });

  it('dedup degrades gracefully when ClaimGroupingTask throws', async () => {
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('你把链式法则当成导数相乘'))
      .mockResolvedValueOnce(sample('你误以为链式法则就是把各层导数相乘'))
      .mockResolvedValueOnce(sample('你认为链式法则等价于将每层求导结果连乘'))
      .mockRejectedValueOnce(new Error('AuthenticationError'));

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(result.confidence).toBeCloseTo(1 / 3, 5);
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
    expect(result.draft.agreement_count).toBe(2);
    // confidence denominator is samples=3 (parse failure is non-agreement).
    expect(result.confidence).toBeCloseTo(2 / 3, 5);
    expect(runTaskFn).toHaveBeenCalledTimes(4);
    const dedupCall = runTaskFn.mock.calls[3];
    expect((dedupCall[1] as { claims: string[] }).claims).toHaveLength(2);
  });

  it('dedup falls back when LLM returns extra indices (flat count > N)', async () => {
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

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    expect(result.draft.agreement_count).toBe(1);
    expect(result.confidence).toBeCloseTo(1 / 3, 5);
  });

  it('dedup falls back on in-range duplicate indices (flat count = N but not a partition)', async () => {
    // [[0, 0], [1]] has flat length 3 = N=3 but index 0 is duplicated and index 2 missing.
    // The old flat-length guard missed this; the partition check catches it.
    const runTaskFn = vi
      .fn<(kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>>()
      .mockResolvedValueOnce(sample('A'))
      .mockResolvedValueOnce(sample('B'))
      .mockResolvedValueOnce(sample('C'))
      .mockResolvedValueOnce(groupResult([[0, 0], [1]])); // flat=[0,0,1], length=3=N but 0 duplicated, 2 missing

    const result = await induceConjecture({ cells: [cell()], samples: 3, runTaskFn });

    // Partition check rejects → falls back to claimKey singletons.
    expect(result.draft.agreement_count).toBe(1);
    expect(result.confidence).toBeCloseTo(1 / 3, 5);
    expect(runTaskFn).toHaveBeenCalledTimes(4); // 3 induction + 1 dedup
  });
});
