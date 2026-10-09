// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppFrame } from './AppFrame';
import { BottomSheet, type SheetSnap } from './BottomSheet';
import { CommandPalette } from './CommandPalette';
import { CompanionPanel } from './CompanionPanel';
import { TabBar } from './TabBar';

afterEach(cleanup);

describe('CompanionPanel', () => {
  it('is out of reach while collapsed (C1, A1)', () => {
    const { rerender } = render(
      <CompanionPanel open={false} label="学习伙伴" header="学习伙伴">
        <button type="button">发送</button>
      </CompanionPanel>,
    );
    const panel = screen.getByRole('complementary', { hidden: true });
    expect(panel.hasAttribute('inert')).toBe(true);
    rerender(
      <CompanionPanel open label="学习伙伴" header="学习伙伴">
        <button type="button">发送</button>
      </CompanionPanel>,
    );
    expect(screen.getByRole('complementary', { name: '学习伙伴' }).hasAttribute('inert')).toBe(
      false,
    );
  });
});

describe('AppFrame', () => {
  it('reflects the sidebar and companion state for layout', () => {
    const { container } = render(
      <AppFrame sidebar="side" sidebarCollapsed topbar="top" companionOpen={false}>
        <p>正文</p>
      </AppFrame>,
    );
    const app = container.querySelector('.un-app');
    expect(app?.getAttribute('data-sidebar')).toBe('collapsed');
    expect(app?.getAttribute('data-companion')).toBe('closed');
    expect(screen.getByRole('main').textContent).toBe('正文');
  });
});

describe('TabBar', () => {
  it('marks the current page and becomes inert when it yields to a sheet (A1)', () => {
    const items = [
      { id: 'home', label: '首页', icon: null, onSelect: vi.fn(), active: true },
      { id: 'lib', label: '资料', icon: null, onSelect: vi.fn() },
    ];
    const { rerender } = render(<TabBar label="主导航" items={items} />);
    expect(screen.getByRole('button', { name: '首页' }).getAttribute('aria-current')).toBe('page');
    rerender(<TabBar label="主导航" items={items} hidden />);
    expect(screen.getByRole('navigation', { hidden: true }).hasAttribute('inert')).toBe(true);
  });
});

describe('CommandPalette', () => {
  const commands = (runA = vi.fn(), runB = vi.fn()) => [
    { id: 'a', group: '前往', label: '回来时', run: runA },
    { id: 'b', group: '动作', label: '记一下', run: runB },
  ];

  it('is inert while closed (A1)', () => {
    const { container } = render(
      <CommandPalette open={false} onClose={vi.fn()} commands={commands()} />,
    );
    expect(container.querySelector('.un-palette-layer')?.hasAttribute('inert')).toBe(true);
  });

  it('moves with arrow keys, runs with Enter and closes first (N4)', async () => {
    const runB = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={commands(vi.fn(), runB)} />);
    const input = screen.getByRole('combobox');
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1].id);
    await userEvent.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
  });

  it('filters, says when nothing matches, and closes on Escape', async () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} commands={commands()} />);
    await userEvent.type(screen.getByRole('combobox'), '不存在');
    expect(screen.getByText('没有匹配的命令')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

function SheetHarness({ initial, canClose = false }: { initial: SheetSnap; canClose?: boolean }) {
  const [snap, setSnap] = useState<SheetSnap>(initial);
  return (
    <BottomSheet
      label="学习伙伴"
      snap={snap}
      onSnapChange={setSnap}
      canClose={canClose}
      header="学习伙伴"
    >
      <button type="button">发送</button>
    </BottomSheet>
  );
}

describe('BottomSheet', () => {
  const grip = () => screen.getByRole('button', { name: /调整学习伙伴的高度/ });
  const sheet = (container: HTMLElement) => container.querySelector('.un-sheet') as HTMLElement;
  // jsdom has no layout: the sheet falls back to the window height for its stops.
  const offsetOf = (container: HTMLElement) =>
    Number(/translate3d\(0(?:px)?, (-?[\d.]+)px/.exec(sheet(container).style.transform)?.[1]);

  it('actually moves to the new stop, not just its label (C2, M3)', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    try {
      const { container } = render(<SheetHarness initial="peek" />);
      const half = Math.round(window.innerHeight * 0.5);
      fireEvent.keyDown(grip(), { key: 'ArrowUp' });
      expect(sheet(container).dataset.snap).toBe('half');
      act(() => vi.advanceTimersByTime(3000));
      expect(offsetOf(container)).toBe(half);
      fireEvent.keyDown(grip(), { key: 'ArrowUp' });
      act(() => vi.advanceTimersByTime(3000));
      expect(offsetOf(container)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes how much of the screen bottom it covers for toasts and scroll padding (M15)', () => {
    const { container } = render(
      <div data-ui-next="">
        <BottomSheet
          label="学习伙伴"
          snap="peek"
          onSnapChange={vi.fn()}
          peekVisible={100}
          bottomInset={80}
          header="学习伙伴"
        >
          正文
        </BottomSheet>
      </div>,
    );
    const root = container.querySelector('[data-ui-next]') as HTMLElement;
    expect(root.style.getPropertyValue('--un-chrome-bottom')).toBe('180px');
  });

  it('reaches every stop from the keyboard (A4, C2)', async () => {
    const { container } = render(<SheetHarness initial="peek" />);
    grip().focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(sheet(container).dataset.snap).toBe('half');
    await userEvent.keyboard('{ArrowUp}');
    expect(sheet(container).dataset.snap).toBe('full');
    await userEvent.keyboard('{End}');
    expect(sheet(container).dataset.snap).toBe('peek');
    await userEvent.keyboard('{ArrowDown}');
    expect(sheet(container).dataset.snap).toBe('peek');
    await userEvent.keyboard('{Enter}');
    expect(sheet(container).dataset.snap).toBe('half');
  });

  it('may close only when allowed, and keeps hidden content inert (A1)', async () => {
    const { container } = render(<SheetHarness initial="peek" canClose />);
    expect(container.querySelector('.un-sheet-body')?.hasAttribute('inert')).toBe(true);
    grip().focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(sheet(container).dataset.snap).toBe('closed');
    expect(sheet(container).hasAttribute('inert')).toBe(true);
  });

  it('settles a cancelled drag at a stop instead of freezing mid-way (C2)', () => {
    const { container } = render(<SheetHarness initial="peek" />);
    const g = grip();
    fireEvent.pointerDown(g, { clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(g, { clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(g, { clientY: 200, pointerId: 1 });
    fireEvent.pointerCancel(g, { clientY: 200, pointerId: 1 });
    expect(['half', 'full']).toContain(sheet(container).dataset.snap);
    expect(sheet(container).style.transform).toMatch(/translate3d/);
  });
});
