import { describe, expect, it } from 'vitest';

import { parseLearningIntentOutline } from '@/server/orchestrator/learning_intent';

describe('parseLearningIntentOutline', () => {
  it('accepts optional long-note proposals alongside hub and atomics', () => {
    const outline = parseLearningIntentOutline(
      JSON.stringify({
        hub: { title: '概率论总览', summary_md: '概率论的基本路径。' },
        atomics: [
          {
            knowledge_id: 'k_conditional',
            title: '条件概率',
            one_line_intent: '能用条件概率公式计算。',
          },
        ],
        longs: [
          {
            knowledge_ids: ['k_conditional', 'k_bayes'],
            title: '条件概率与贝叶斯综合',
            one_line_intent: '能把条件概率和贝叶斯公式放进同一条解题路径。',
          },
        ],
      }),
    );

    expect(outline.longs).toEqual([
      {
        knowledge_ids: ['k_conditional', 'k_bayes'],
        title: '条件概率与贝叶斯综合',
        one_line_intent: '能把条件概率和贝叶斯公式放进同一条解题路径。',
      },
    ]);
  });

  it('defaults missing longs to an empty array', () => {
    const outline = parseLearningIntentOutline(
      JSON.stringify({
        hub: { title: '虚词总览', summary_md: '虚词学习路径。' },
        atomics: [{ knowledge_id: 'k_zhi', title: '之', one_line_intent: '区分之的用法。' }],
      }),
    );

    expect(outline.longs).toEqual([]);
  });
});
