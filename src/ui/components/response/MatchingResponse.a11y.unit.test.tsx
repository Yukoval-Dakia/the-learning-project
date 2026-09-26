// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MatchingResponse } from './MatchingResponse';

afterEach(cleanup);

describe('MatchingResponse keyboard access', () => {
  it('labels each native select and updates exclusive pairs by keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MatchingResponse
        left={[
          { id: 'l1', text_md: '原因' },
          { id: 'l2', text_md: '结果' },
        ]}
        right={[
          { id: 'r1', text_md: '蒸发' },
          { id: 'r2', text_md: '凝结' },
        ]}
        value={{ l1: null, l2: null }}
        onChange={onChange}
      />,
    );
    const select = screen.getByRole('combobox', { name: '原因 的匹配项' });
    await user.selectOptions(select, 'r1');
    expect(onChange).toHaveBeenLastCalledWith({ l1: 'r1', l2: null });
    expect(screen.getByRole('group', { name: '配对作答' })).toBeTruthy();
  });

  it('permits clearing a pair and respects disabled state', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <MatchingResponse
        left={[{ id: 'l1', text_md: '左项' }]}
        right={[{ id: 'r1', text_md: '右项' }]}
        value={{ l1: 'r1' }}
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getByRole('combobox'), '');
    expect(onChange).toHaveBeenLastCalledWith({ l1: null });
    rerender(
      <MatchingResponse
        left={[{ id: 'l1', text_md: '左项' }]}
        right={[{ id: 'r1', text_md: '右项' }]}
        value={{ l1: 'r1' }}
        onChange={onChange}
        disabled
      />,
    );
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
  });
});
