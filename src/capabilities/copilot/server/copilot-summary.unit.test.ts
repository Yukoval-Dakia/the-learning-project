import { describe, expect, it } from 'vitest';
import { learnerGlobalBrief, learnerProposalSummary } from '@/server/today/copilot-summary';

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

describe('Copilot learner global brief projection', () => {
  it('hides an internal English memory digest with raw event identity', () => {
    const raw =
      '- **Heavy copilot usage**: Multiple ask to reply tool cycles succeeded for copilot_user_ask_e5a0aee1. The learner is exploring internal workflows.';

    expect(learnerGlobalBrief(raw)).toBeNull();
  });

  it('keeps concise Chinese learner-facing copy', () => {
    expect(learnerGlobalBrief('这周重点是区分条件概率、全概率公式和贝叶斯公式。')).toBe(
      '这周重点是区分条件概率、全概率公式和贝叶斯公式。',
    );
  });
});
