import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { QRow } from './QuestionsPage';
import type { QBankQuestion } from './practice-api';

function question(subject: string, notation: string | null, prompt_md: string): QBankQuestion {
  return {
    id: `q-${subject}`,
    kind: 'choice',
    prompt_md,
    source: 'manual',
    source_tier: { tier: 1, name: 'authentic' },
    difficulty: 2,
    visual_complexity: null,
    knowledge_ids: [],
    root_question_id: null,
    variant_depth: 0,
    parent_question_id: null,
    part_index: null,
    draft_status: null,
    created_at_sec: 1_784_000_000,
    subject,
    notation,
    knowledge_labels: [],
    is_composite: false,
    children: [],
  };
}

describe('QuestionsPage subject notation', () => {
  it('keeps wenyan dollar punctuation literal', () => {
    const html = renderToString(
      <QRow
        q={question('yuwen', null, '《史记》标价 $12$，并非公式。')}
        go={vi.fn()}
        subjectRows={[]}
      />,
    );

    expect(html).not.toContain('class="katex"');
    expect(html).toContain('$12$');
  });

  it('renders a retired custom math subject from the server-projected notation', () => {
    const html = renderToString(
      <QRow
        q={question('subj_retired_math', 'katex', '计算 $x^2$')}
        go={vi.fn()}
        subjectRows={[]}
      />,
    );

    expect(html).toContain('class="katex"');
  });
});
