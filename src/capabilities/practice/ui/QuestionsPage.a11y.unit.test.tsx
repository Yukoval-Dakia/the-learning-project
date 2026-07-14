// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QRow, questionRowAccessibleName } from './QuestionsPage';
import type { QBankQuestion } from './practice-api';

afterEach(cleanup);

const composite: QBankQuestion = {
  id: 'question_composite_1',
  kind: 'reading',
  prompt_md: '阅读材料并回答问题。',
  source: 'manual',
  source_tier: { tier: 1, name: '人工' },
  difficulty: 3,
  visual_complexity: null,
  knowledge_ids: [],
  root_question_id: null,
  variant_depth: 0,
  parent_question_id: null,
  part_index: null,
  draft_status: null,
  created_at_sec: 1_784_000_000,
  subject: 'yuwen',
  knowledge_labels: [],
  is_composite: true,
  children: [],
};

describe('question row interaction semantics', () => {
  it('opens from Enter and Space while keeping expand as a sibling control', async () => {
    const go = vi.fn();
    const onToggle = vi.fn();
    render(<QRow q={composite} go={go} subjectRows={[]} expanded={false} onToggle={onToggle} />);

    const row = screen.getByRole('button', { name: /阅读材料并回答问题/ });
    expect(within(row).queryByRole('button')).toBeNull();
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(go).toHaveBeenNthCalledWith(1, '/questions/question_composite_1');
    expect(go).toHaveBeenNthCalledWith(2, '/questions/question_composite_1');

    await userEvent.click(screen.getByRole('button', { name: '展开小题' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledTimes(2);
  });

  it('keeps a long prompt out of the row accessible name', () => {
    const long = {
      ...composite,
      is_composite: false,
      prompt_md: `这是一道很长的题目，${'后续材料不应全部进入可访问名称。'.repeat(20)}`,
    };
    const name = questionRowAccessibleName(long);

    expect(name).toMatch(/^打开题目：这是一道很长的题目/);
    expect(name).toContain('…');
    expect(name.length).toBeLessThan(60);
    expect(name).not.toContain(long.prompt_md);
  });
});
