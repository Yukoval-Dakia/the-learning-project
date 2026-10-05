// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrderingResponse } from './OrderingResponse';

afterEach(cleanup);

const items = [
  { id: 'a', text_md: '先观察' },
  { id: 'b', text_md: '再计算' },
  { id: 'c', text_md: '最后检验' },
];

describe('OrderingResponse keyboard access', () => {
  it('moves items with named buttons and announces the new position', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OrderingResponse items={items} value={['a', 'b', 'c']} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: '下移「先观察」' }));
    expect(onChange).toHaveBeenLastCalledWith(['b', 'a', 'c']);
    expect(screen.getByText('「先观察」移到第 2 位')).toBeTruthy();
    expect(screen.getByRole('list', { name: '排序作答' })).toBeTruthy();
  });

  it('accepts direct position edits by keyboard and disables boundary moves', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OrderingResponse items={items} value={['a', 'b', 'c']} onChange={onChange} />);
    expect(
      (screen.getByRole('button', { name: '上移「先观察」' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const position = screen.getByRole('textbox', { name: '「先观察」的目标序号（1 到 3）' });
    await user.clear(position);
    await user.type(position, '3');
    fireEvent.keyDown(position, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['b', 'c', 'a']);
  });
});
