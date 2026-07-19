// @vitest-environment jsdom

// YUK-718 — CopilotDrawer is role="dialog" but shipped only an ad-hoc open-focus
// effect (no trap/restore, ad-hoc window Esc). It now uses the shared useFocusTrap
// primitive (same as NodeDrawer / CommandPalette). These tests exercise the real
// focus behavior in jsdom.

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopilotDrawer } from './CopilotDrawer';

afterEach(cleanup);

describe('CopilotDrawer focus trap (YUK-718)', () => {
  it('moves focus into the panel on open', () => {
    render(
      <CopilotDrawer open onClose={vi.fn()} footer={<input data-testid="composer" />}>
        <div>chat</div>
      </CopilotDrawer>,
    );
    const panel = document.querySelector('[data-testid="copilot-drawer-panel"]');
    expect(panel).not.toBeNull();
    // First focusable inside the panel receives focus (not left on <body>).
    expect(document.activeElement).not.toBe(document.body);
    expect(panel?.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape via the trap (no separate window listener)', () => {
    const onClose = vi.fn();
    render(
      <CopilotDrawer open onClose={onClose}>
        <div>chat</div>
      </CopilotDrawer>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the trigger when it closes', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { rerender } = render(
      <CopilotDrawer open onClose={vi.fn()}>
        <div>chat</div>
      </CopilotDrawer>,
    );
    // Focus was pulled into the drawer.
    expect(document.activeElement).not.toBe(trigger);

    rerender(
      <CopilotDrawer open={false} onClose={vi.fn()}>
        <div>chat</div>
      </CopilotDrawer>,
    );
    // Trap cleanup restores focus to the element that had it before open.
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
