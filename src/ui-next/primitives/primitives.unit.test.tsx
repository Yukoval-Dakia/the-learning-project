// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Expand } from './Expand';
import { IconButton } from './IconButton';
import { RollNumber } from './RollNumber';
import { Segmented } from './Segmented';
import { Toaster, useToaster } from './Toaster';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('IconButton', () => {
  it('names an icon-only button for assistive tech (N5)', () => {
    render(<IconButton label="收起学习伙伴" icon={<svg />} />);
    expect(screen.getByRole('button', { name: '收起学习伙伴' })).toBeTruthy();
  });
});

describe('Expand', () => {
  it('is inert while closed and reachable once open (A1)', () => {
    const { container, rerender } = render(
      <Expand open={false} id="why">
        <button type="button">换一种</button>
      </Expand>,
    );
    const region = container.querySelector('#why');
    expect(region?.hasAttribute('inert')).toBe(true);
    rerender(
      <Expand open id="why">
        <button type="button">换一种</button>
      </Expand>,
    );
    expect(region?.hasAttribute('inert')).toBe(false);
  });
});

describe('Segmented', () => {
  it('exposes a named radio group and reports the chosen value', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="资料分类"
        value="questions"
        onChange={onChange}
        options={[
          { value: 'questions', label: '题目', count: 6 },
          { value: 'notes', label: '笔记', count: 4 },
        ]}
      />,
    );
    expect(screen.getByRole('group', { name: '资料分类' })).toBeTruthy();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    await userEvent.click(screen.getByText('笔记'));
    expect(onChange).toHaveBeenCalledWith('notes');
  });
});

describe('RollNumber', () => {
  it('rolls up when the count grows and down when it shrinks (M9)', () => {
    const { container, rerender } = render(<RollNumber value={3} />);
    const roll = () => container.querySelector('.un-roll');
    rerender(<RollNumber value={4} />);
    expect(roll()?.getAttribute('data-dir')).toBe('up');
    rerender(<RollNumber value={2} />);
    expect(roll()?.getAttribute('data-dir')).toBe('down');
    expect(roll()?.querySelector('.un-roll-out')?.getAttribute('aria-hidden')).toBe('true');
  });
});

function ToastHarness({ onUndo }: { onUndo: () => void }) {
  const { toasts, push, dismiss } = useToaster();
  return (
    <>
      <button
        type="button"
        onClick={() => push('已推迟：短对比例子', { label: '撤销', run: onUndo })}
      >
        推迟
      </button>
      <Toaster toasts={toasts} dismiss={dismiss} />
    </>
  );
}

describe('Toaster', () => {
  it('announces politely and runs the undo once (M10)', async () => {
    const onUndo = vi.fn();
    const { container } = render(<ToastHarness onUndo={onUndo} />);
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '推迟' }));
    await userEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('已推迟：短对比例子')).toBeNull();
  });

  it('closes after the undo window, but not while it has focus (WCAG 2.2.1)', () => {
    vi.useFakeTimers();
    render(<ToastHarness onUndo={vi.fn()} />);
    act(() => screen.getByRole('button', { name: '推迟' }).click());
    act(() => screen.getByRole('button', { name: '撤销' }).focus());
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText('已推迟：短对比例子')).toBeTruthy();
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.queryByText('已推迟：短对比例子')).toBeNull();
  });
});
