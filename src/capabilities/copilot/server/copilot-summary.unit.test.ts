import { describe, expect, it } from 'vitest';
import { learnerProposalSummary } from '@/server/today/copilot-summary';

describe('Copilot learner proposal projection', () => {
  it('replaces an internal proposal kind with concise learner copy', () => {
    const summary = learnerProposalSummary('knowledge_mutation');

    expect(summary).toBe('有一项知识内容建议待你查看。');
    expect(summary).not.toContain('knowledge_mutation');
  });

  it('uses stable generic learner copy for an unknown proposal kind', () => {
    expect(learnerProposalSummary('internal_future_kind')).toBe('有一项学习建议待你查看。');
  });
});
