// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeleteModal } from './QuestionDetailPage';

afterEach(cleanup);

describe('QuestionDetailPage delete association modal (YUK-298)', () => {
  it('surfaces attached children and requires the destructive confirmation phrase', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <DeleteModal
        stem="阅读材料"
        notation={null}
        counts={{ attempts: 0, mistakes: 0, fsrs_cards: 0, paper_refs: 0, children: 2 }}
        pending={false}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText(/道小题挂在此大题下/).textContent).toContain('2');
    expect(screen.getByText(/母题及 2 道挂载小题将一并从题库和练习池移除并转为草稿/)).toBeTruthy();
    const deleteButton = screen.getByRole('button', { name: '从题库移除' });
    expect((deleteButton as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByPlaceholderText('删除'), '删除');
    expect((deleteButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(deleteButton);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
