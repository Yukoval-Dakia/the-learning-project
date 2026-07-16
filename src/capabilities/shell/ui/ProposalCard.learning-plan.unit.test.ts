import { describe, expect, it } from 'vitest';
import { learningItemPlanPreviewOf } from './ProposalCard';

describe('learningItemPlanPreviewOf', () => {
  it('projects hub, atomic, and long steps from a learning_item proposal', () => {
    expect(
      learningItemPlanPreviewOf({
        hub: { title: '概率论主线', summary_md: '先基础，后综合。' },
        atomics: [{ title: '条件概率', one_line_intent: '会使用贝叶斯公式。' }],
        longs: [{ title: '综合建模', one_line_intent: '完成一组综合题。' }],
      }),
    ).toEqual({
      hubTitle: '概率论主线',
      summary: '先基础，后综合。',
      steps: [
        { title: '条件概率', intent: '会使用贝叶斯公式。', kind: 'atomic' },
        { title: '综合建模', intent: '完成一组综合题。', kind: 'long' },
      ],
    });
  });

  it('fails closed on unrelated or malformed proposal payloads', () => {
    expect(learningItemPlanPreviewOf(null)).toBeNull();
    expect(learningItemPlanPreviewOf({ hub: {}, atomics: 'wrong' })).toBeNull();
  });
});
