// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePagehideTransition } from './usePagehideTransition';

function Harness({
  enabled = true,
  transition,
}: {
  enabled?: boolean;
  transition: (event: PageTransitionEvent) => unknown;
}) {
  usePagehideTransition(transition, enabled);
  return null;
}

afterEach(cleanup);

describe('usePagehideTransition (YUK-211)', () => {
  it('runs the latest transition once per pagehide event', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<Harness transition={first} />);
    view.rerender(<Harness transition={latest} />);

    window.dispatchEvent(new Event('pagehide'));

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(expect.objectContaining({ type: 'pagehide' }));
  });

  it('honors the latest enabled state and removes the listener on unmount', () => {
    const transition = vi.fn();
    const view = render(<Harness transition={transition} enabled />);
    view.rerender(<Harness transition={transition} enabled={false} />);

    window.dispatchEvent(new Event('pagehide'));
    expect(transition).not.toHaveBeenCalled();

    view.rerender(<Harness transition={transition} enabled />);
    view.unmount();
    window.dispatchEvent(new Event('pagehide'));
    expect(transition).not.toHaveBeenCalled();
  });

  it('does not leak rejected best-effort transitions', async () => {
    const unhandled = vi.fn();
    window.addEventListener('unhandledrejection', unhandled);
    render(<Harness transition={() => Promise.reject(new Error('page is leaving'))} />);

    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    await Promise.resolve();

    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener('unhandledrejection', unhandled);
  });
});
