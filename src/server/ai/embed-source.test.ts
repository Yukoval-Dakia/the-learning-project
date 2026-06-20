import { describe, expect, it } from 'vitest';
import { embedHash, knowledgeEmbedText, questionEmbedText } from './embed-source';

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
  it('knowledge = name + effectiveDomain (无 description 列)', () => {
    expect(knowledgeEmbedText({ name: '虚词', effectiveDomain: '古文' })).toBe('虚词\n古文');
  });
  it('tolerates null reference/choices/effectiveDomain', () => {
    expect(questionEmbedText({ prompt_md: 'p', reference_md: null, choices_md: null })).toBe('p');
    expect(knowledgeEmbedText({ name: 'n', effectiveDomain: null })).toBe('n');
  });
  it('clamps overlong question text to 6000 chars', () => {
    const long = 'x'.repeat(7000);
    const t = questionEmbedText({ prompt_md: long, reference_md: null, choices_md: null });
    expect(t).toHaveLength(6000);
  });
  it('clamps overlong knowledge text to 6000 chars', () => {
    const t = knowledgeEmbedText({ name: 'y'.repeat(7000), effectiveDomain: null });
    expect(t).toHaveLength(6000);
  });

  // YUK-393 — effective-domain folding disambiguates same-named cross-subject KCs.
  it('two same-named KCs under different effective domains get distinct embed text', () => {
    const physics = knowledgeEmbedText({ name: '周期', effectiveDomain: '物理' });
    const chemistry = knowledgeEmbedText({ name: '周期', effectiveDomain: '化学' });
    expect(physics).not.toBe(chemistry);
    expect(physics).toBe('周期\n物理');
    expect(chemistry).toBe('周期\n化学');
  });

  // YUK-393 — embedHash is a stable sha256 of the embed-source text.
  it('embedHash is deterministic and content-sensitive', () => {
    const a = embedHash(questionEmbedText({ prompt_md: 'P', reference_md: 'R', choices_md: null }));
    const b = embedHash(questionEmbedText({ prompt_md: 'P', reference_md: 'R', choices_md: null }));
    const c = embedHash(
      questionEmbedText({ prompt_md: 'P2', reference_md: 'R', choices_md: null }),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
