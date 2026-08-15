import { describe, expect, it } from 'vitest';
import { type FewShotExample, renderFewShotBlock } from './fewshot-retrieve';

const ex = (over: Partial<FewShotExample>): FewShotExample => ({
  id: 'q1',
  kind: 'translation',
  prompt_md: '翻译：学而时习之',
  reference_md: '参考译文：学了又按时温习',
  choices_md: null,
  rubric_json: null,
  difficulty: 3,
  knowledge_ids: ['k1'],
  tier: 4,
  ...over,
});

describe('renderFewShotBlock', () => {
  it('降级: empty input → empty string (no block injected)', () => {
    expect(renderFewShotBlock([])).toBe('');
  });

  it('renders prompt + reference + the no-copy warning', () => {
    const block = renderFewShotBlock([ex({})]);
    expect(block).toContain('不要照抄题面');
    expect(block).toContain('翻译：学而时习之');
    expect(block).toContain('参考译文');
    expect(block).toContain('tier 4');
  });

  it('includes choices when present', () => {
    const block = renderFewShotBlock([
      ex({ kind: 'single_choice', choices_md: ['A. 甲', 'B. 乙'], tier: 1 }),
    ]);
    expect(block).toContain('选项：A. 甲 / B. 乙');
    expect(block).toContain('tier 1');
  });

  it('numbers multiple examples', () => {
    const block = renderFewShotBlock([ex({ id: 'a' }), ex({ id: 'b' })]);
    expect(block).toContain('范例 1');
    expect(block).toContain('范例 2');
  });
});
