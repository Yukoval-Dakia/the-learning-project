import { describe, expect, it, vi } from 'vitest';
import { applyDecisionGates, deduplicateDecisions } from './reconcile-decisions';
import type {
  CandidateEntry,
  NewMemoryEntry,
  ReconcileAction,
  ReconcileDecision,
} from './reconcile-llm';

const memory: NewMemoryEntry = {
  index: 0,
  kind: 'preference',
  memory_id: 'new-memory',
  created_ms: 1791115200000,
  text: '学习函数时希望先画图，再逐步解释定义域。\n此前遇到复合条件会遗漏端点；这条记录不应被模型自动覆盖。',
};
function decision(overrides: Partial<ReconcileDecision> = {}): ReconcileDecision {
  return {
    new_index: 0,
    old_index: 0,
    action: 'MERGE',
    confidence: 0.92,
    reason: '两条记录相近，但保留历史时间和原始措辞。',
    merged_text: '模型提出的合并文本',
    ...overrides,
  };
}
function candidate(score?: number, index = 0): CandidateEntry {
  return {
    index,
    memory_id: `old-${index}`,
    text: '原始偏好：先定义后例题。保留解释与证据。',
    created_ms: 1788523200000,
    score,
  };
}

describe('reconciliation decision gates', () => {
  it.each(['weakness', 'event'])(
    'applies the %s MERGE gate before score and approval gates',
    (kind) => {
      const warn = vi.fn();
      const d = decision();
      const result = applyDecisionGates(d, { ...memory, kind }, [candidate(0.1)], warn);
      expect(result).toMatchObject({
        action: 'KEEP_BOTH',
        referencedScore: undefined,
        corroborated: true,
        reason: `Per-kind guard (kind=${kind} forbids MERGE); downgraded from MERGE. ${d.reason}`,
      });
      expect(warn.mock.calls).toEqual([
        [`[memory_reconcile] per-kind MERGE suppressed (kind=${kind}) new_index=0`],
      ]);
      expect(d.action).toBe('MERGE');
    },
  );

  it.each([0, 0.499, Number.NaN])(
    'preserves score-floor denial for score %s before human approval',
    (score) => {
      const warn = vi.fn();
      const d = decision();
      const result = applyDecisionGates(d, memory, [candidate(score)], warn);
      expect(result.action).toBe('KEEP_BOTH');
      expect(result.corroborated).toBe(false);
      expect(result.referencedScore).toBe(score);
      expect(result.reason).toBe(
        `Low structural corroboration (score=${score}); downgraded from MERGE. ${d.reason}`,
      );
      expect(warn.mock.calls).toEqual([
        [`[memory_reconcile] score-floor downgrade (score=${score}) new_index=0`],
      ]);
    },
  );

  it.each([0.5, 0.99])(
    'still blocks a well-corroborated score %s MERGE on human approval',
    (score) => {
      const d = decision();
      const result = applyDecisionGates(d, memory, [candidate(score)]);
      expect(result).toMatchObject({
        action: 'KEEP_BOTH',
        referencedScore: score,
        corroborated: true,
        reason: `Human approval required; blocked model-recommended MERGE. ${d.reason}`,
      });
    },
  );

  it('uses the maximum score only for a RETRACT_NEW with null old_index', () => {
    const d = decision({ action: 'RETRACT_NEW', old_index: null });
    expect(applyDecisionGates(d, memory, [candidate(0.1), candidate(0.9, 1)])).toMatchObject({
      action: 'KEEP_BOTH',
      referencedScore: 0.9,
      corroborated: true,
      reason: `Human approval required; blocked model-recommended RETRACT_NEW. ${d.reason}`,
    });
  });

  it.each(['MERGE', 'RETRACT_NEW'] as const)(
    'abstains on a scoreless referenced %s candidate without borrowing siblings',
    (action) => {
      const warn = vi.fn();
      const d = decision({ action });
      const result = applyDecisionGates(d, memory, [candidate(), candidate(0.1, 1)], warn);
      expect(result).toMatchObject({
        action: 'KEEP_BOTH',
        referencedScore: undefined,
        corroborated: true,
      });
      expect(warn.mock.calls).toEqual([
        [
          `[memory_reconcile] score-floor skipped (no candidate score) action=${action} new_index=0`,
        ],
        [`[memory_reconcile] destructive recommendation blocked action=${action} new_index=0`],
      ]);
    },
  );

  it('abstains without neighbors but still blocks RETRACT_NEW', () => {
    const warn = vi.fn();
    const result = applyDecisionGates(
      decision({ action: 'RETRACT_NEW', old_index: null }),
      memory,
      [],
      warn,
    );
    expect(result).toMatchObject({
      action: 'KEEP_BOTH',
      referencedScore: undefined,
      corroborated: true,
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each(['KEEP_BOTH', 'SUPERSEDE', 'MERGE', 'RETRACT_NEW'] as const)(
    'rejects an explicit invalid old_index for %s before all other gates',
    (action) => {
      const warn = vi.fn();
      const d = decision({ action, old_index: 99 });
      expect(
        applyDecisionGates(d, { ...memory, kind: 'weakness' }, [candidate(0.99)], warn),
      ).toMatchObject({
        action: 'KEEP_BOTH',
        referencedScore: undefined,
        corroborated: true,
        reason: `out-of-range index downgraded from ${action}. ${d.reason}`,
      });
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing new memory without dereferencing it', () => {
    const d = decision({ new_index: 99 });
    expect(applyDecisionGates(d, undefined, [candidate(0.99)])).toMatchObject({
      action: 'KEEP_BOTH',
      reason: `out-of-range index downgraded from MERGE. ${d.reason}`,
    });
  });

  it.each(['SUPERSEDE', 'MERGE'] as const)(
    'requires an old target for %s even with null old_index',
    (action) => {
      const d = decision({ action, old_index: null });
      expect(applyDecisionGates(d, memory, [candidate(0.99)]).reason).toBe(
        `out-of-range index downgraded from ${action}. ${d.reason}`,
      );
    },
  );

  it('keeps SUPERSEDE exempt from score-floor but subject to human approval', () => {
    const d = decision({ action: 'SUPERSEDE' });
    expect(applyDecisionGates(d, memory, [candidate(0.01)])).toMatchObject({
      action: 'KEEP_BOTH',
      referencedScore: undefined,
      corroborated: true,
      reason: `Human approval required; blocked model-recommended SUPERSEDE. ${d.reason}`,
    });
  });

  it('leaves a valid KEEP_BOTH reason unchanged', () => {
    const d = decision({ action: 'KEEP_BOTH', old_index: null });
    expect(applyDecisionGates(d, memory, []).reason).toBe(d.reason);
  });

  it('keeps the first decision for each index and reports duplicate drops in input order', () => {
    const actions: ReconcileAction[] = ['KEEP_BOTH', 'MERGE', 'SUPERSEDE', 'RETRACT_NEW'];
    const inputs = actions.map((action, i) => decision({ action, new_index: i % 2 }));
    const warn = vi.fn();
    const deduped = deduplicateDecisions(inputs, warn);
    expect(deduped).toEqual(inputs.slice(0, 2));
    expect(deduped[0]).toBe(inputs[0]);
    expect(warn.mock.calls).toEqual([
      ['[memory_reconcile] duplicate new_index 0 dropped (action=SUPERSEDE); first decision wins'],
      [
        '[memory_reconcile] duplicate new_index 1 dropped (action=RETRACT_NEW); first decision wins',
      ],
    ]);
  });
});
