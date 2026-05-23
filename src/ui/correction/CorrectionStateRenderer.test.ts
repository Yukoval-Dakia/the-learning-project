import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CorrectionStateRenderer } from './CorrectionStateRenderer';

vi.mock('@/ui/primitives/Badge', async () => {
  const React = await import('react');
  return {
    Badge: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('span', null, children),
  };
});

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({
      href,
      children,
    }: {
      href: string;
      children?: React.ReactNode;
    }) => React.createElement('a', { href }, children),
  };
});

describe('CorrectionStateRenderer', () => {
  it('hides active states by default', () => {
    const html = renderToString(
      CorrectionStateRenderer({
        state: {
          state: 'active',
          terminal_state: 'active',
          effective_event_id: 'evt_active',
          correction_event_id: null,
          replacement_event_id: null,
        },
      }),
    );
    expect(html).toBe('');
  });

  it('renders active states when showActive=true', () => {
    const html = renderToString(
      CorrectionStateRenderer({
        showActive: true,
        state: {
          state: 'active',
          terminal_state: 'active',
          effective_event_id: 'evt_active',
          correction_event_id: null,
          replacement_event_id: null,
        },
      }),
    );
    expect(html).toContain('active');
  });

  it('renders superseded replacement and correction links', () => {
    const html = renderToString(
      CorrectionStateRenderer({
        state: {
          state: 'superseded',
          terminal_state: 'active',
          effective_event_id: 'evt_replacement_123',
          correction_event_id: 'evt_correct_456',
          replacement_event_id: 'evt_replacement_123',
        },
      }),
    );
    expect(html).toContain('已替换');
    expect(html).toContain('/events/evt_replacement_123');
    expect(html).toContain('/events/evt_correct_456');
  });
});
