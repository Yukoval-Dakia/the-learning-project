import { describe, expect, it } from 'vitest';
import { learnerGlobalBrief } from './learner-global-brief';

describe('learnerGlobalBrief', () => {
  it('hides an internal English memory digest with raw event identity', () => {
    const raw =
      '- **Heavy copilot usage**: Multiple ask to reply tool cycles succeeded for copilot_user_ask_e5a0aee1.';

    expect(learnerGlobalBrief(raw)).toBeNull();
  });

  it('keeps concise Chinese learner-facing copy', () => {
    expect(learnerGlobalBrief('这周重点是区分条件概率、全概率公式和贝叶斯公式。')).toBe(
      '这周重点是区分条件概率、全概率公式和贝叶斯公式。',
    );
  });
});
