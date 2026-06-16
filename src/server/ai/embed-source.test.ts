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
});
