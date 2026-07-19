import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MistakeCard, type MistakeRow } from './MistakesPage';

function mistake(referenceMd: string | null): MistakeRow {
  return {
    id: 'attempt_1',
    record_id: 'record_1',
    question_id: 'question_1',
    prompt_md: '“之”在主谓之间有什么作用？',
    reference_md: referenceMd,
    wrong_answer_md: '代词',
    knowledge_ids: ['knowledge_1'],
    cause: {
      source: 'agent',
      primary_category: 'concept',
      secondary_categories: [],
      user_notes: null,
      confidence: 0.9,
    },
    correction_state: { terminal_state: 'active' },
    created_at: 1_700_000_000,
  };
}

function renderMistake(referenceMd: string | null): string {
  return renderToString(
    <MistakeCard
      m={mistake(referenceMd)}
      subject={null}
      subjectRows={[]}
      kpName={() => '主谓取消独立性'}
      navigate={vi.fn()}
    />,
  );
}

describe('MistakeCard reference answer comparison', () => {
  it('renders both the wrong answer and the available reference answer', () => {
    const html = renderMistake('取消句子独立性');

    expect(html).toContain('cmp-wrong');
    expect(html).toContain('代词');
    expect(html).toContain('cmp-right');
    expect(html).toContain('取消句子独立性');
    expect(html).toContain('>正<');
  });

  it.each([null, '', '   '])('omits the right-hand row when reference_md is %j', (value) => {
    const html = renderMistake(value);

    expect(html).toContain('cmp-wrong');
    expect(html).not.toContain('cmp-right');
    expect(html).not.toContain('>正<');
  });
});
