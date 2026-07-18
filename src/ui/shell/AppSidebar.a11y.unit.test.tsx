// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppSidebar } from './AppSidebar';

afterEach(cleanup);

const baseProps = {
  pathname: '/today',
  navigate: vi.fn(),
  onOpenCopilot: vi.fn(),
  theme: 'light' as const,
  onToggleTheme: vi.fn(),
  inboxCount: 0,
};

describe('AppSidebar mobile accessibility', () => {
  it('removes a closed off-canvas rail from assistive navigation', () => {
    const { container } = render(
      <AppSidebar {...baseProps} mobileLayout mobileOpen={false} onNavigated={vi.fn()} />,
    );
    const sidebar = container.querySelector('aside');
    expect(sidebar?.hasAttribute('inert')).toBe(true);
    expect(sidebar?.getAttribute('aria-hidden')).toBe('true');
    expect(sidebar?.getAttribute('role')).toBeNull();
  });

  it('exposes an open rail as a modal dialog, traps focus, and closes on Escape', async () => {
    const close = vi.fn();
    const { container } = render(
      <AppSidebar {...baseProps} mobileLayout mobileOpen onNavigated={close} />,
    );
    const sidebar = container.querySelector('aside');
    expect(sidebar?.hasAttribute('inert')).toBe(false);
    expect(sidebar?.getAttribute('role')).toBe('dialog');
    expect(sidebar?.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('dialog', { name: '主导航' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Loom/ }));

    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the desktop rail interactive when the mobile drawer is closed', () => {
    const { container } = render(
      <AppSidebar {...baseProps} mobileLayout={false} mobileOpen={false} onNavigated={vi.fn()} />,
    );
    expect(container.querySelector('aside')?.hasAttribute('inert')).toBe(false);
  });

  it('keeps the Inbox badge visible without fabricating an exact truncated count', () => {
    render(
      <AppSidebar
        {...baseProps}
        inboxCount={0}
        inboxCountUncertain
        mobileLayout={false}
        mobileOpen={false}
      />,
    );

    expect(screen.getByLabelText('待审提议数量未完全统计').textContent).toBe('?');
  });
});
