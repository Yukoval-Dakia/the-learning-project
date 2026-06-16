import { describe, expect, it } from 'vitest';
import { knowledgeEmbedText, questionEmbedText } from './embed-source';

describe('embed source text', () => {
  it('question = prompt + reference + choices joined', () => {
    const t = questionEmbedText({
      prompt_md: '题面',
      reference_md: '答案',
      choices_md: ['A', 'B'],
    });
    expect(t).toContain('题面');
    expect(t).toContain('答案');
    expect(t).toContain('A');
  });
  it('knowledge = name + domain (无 description 列)', () => {
    expect(knowledgeEmbedText({ name: '虚词', domain: '古文' })).toBe('虚词\n古文');
  });
  it('tolerates null reference/choices/domain', () => {
    expect(questionEmbedText({ prompt_md: 'p', reference_md: null, choices_md: null })).toBe('p');
    expect(knowledgeEmbedText({ name: 'n', domain: null })).toBe('n');
  });
  it('clamps overlong question text to 6000 chars', () => {
    const long = 'x'.repeat(7000);
    const t = questionEmbedText({ prompt_md: long, reference_md: null, choices_md: null });
    expect(t).toHaveLength(6000);
  });
  it('clamps overlong knowledge text to 6000 chars', () => {
    const t = knowledgeEmbedText({ name: 'y'.repeat(7000), domain: null });
    expect(t).toHaveLength(6000);
  });
});
