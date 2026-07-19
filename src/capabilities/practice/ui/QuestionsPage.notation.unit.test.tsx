import type { ApiSubject } from '@/ui/hooks/useSubjects';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { QRow } from './QuestionsPage';
import type { QBankQuestion } from './practice-api';

const SUBJECTS: ApiSubject[] = [
  {
    id: 'yuwen',
    displayName: '语文',
    aliases: ['wenyan'],
    renderConfig: { font_family: 'serif-cjk', notation: null, code_highlight: null },
    causeCategories: [],
    isGeneralFallback: false,
    configurationStatus: 'configured',
  },
  {
    id: 'math',
    displayName: '数学',
    aliases: [],
    renderConfig: { font_family: 'system', notation: 'katex', code_highlight: null },
    causeCategories: [],
    isGeneralFallback: false,
    configurationStatus: 'configured',
  },
];

function question(subject: string, prompt_md: string): QBankQuestion {
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
    knowledge_labels: [],
    is_composite: false,
    children: [],
  };
}

describe('QuestionsPage subject notation', () => {
  it('keeps wenyan dollar punctuation literal', () => {
    const html = renderToString(
      <QRow
        q={question('wenyan', '《史记》标价 $12$，并非公式。')}
        go={vi.fn()}
        subjectRows={SUBJECTS}
      />,
    );

    expect(html).not.toContain('class="katex"');
    expect(html).toContain('$12$');
  });

  it('renders math with the canonical katex profile notation', () => {
    const html = renderToString(
      <QRow q={question('math', '计算 $x^2$')} go={vi.fn()} subjectRows={SUBJECTS} />,
    );

    expect(html).toContain('class="katex"');
  });
});
