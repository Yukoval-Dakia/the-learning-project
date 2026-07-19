// @vitest-environment jsdom
//
// YUK-715 — render-count probe for the memoized MessageRow. A live SSE reply
// grows one message per token via `setMessages(prev => prev.map(...))`, which
// keeps every OTHER message object referentially identical. MessageRow is
// memoized, so only the growing row should re-render (re-parse markdown); the
// static replay rows must not. We mock the (heavy) DeferredMarkdownRenderer to
// count parses per message and drive a harness that replays that exact update
// shape — including the stable `navigate` / `onAcceptCorrective` refs the real
// Dock passes (a prop, and a useCallback([]) handler).
//
// A full CopilotDock render mounts stores / SSE / query wiring (see the sibling
// source-level tests), so we exercise the extracted row in isolation instead.

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { markdownRenders } = vi.hoisted(() => ({ markdownRenders: [] as string[] }));

vi.mock('@/ui/lib/deferred-markdown-renderer', () => ({
  DeferredMarkdownRenderer: ({ children }: { children: string }) => {
    markdownRenders.push(children);
    return <div>{children}</div>;
  },
  preloadMarkdownRenderer: () => {},
}));

import { type ChatMessage, MessageRow } from './CopilotDock';

// Module-level stable refs — inlining these in the harness would recreate them
// each render and defeat the memo we are trying to measure (the real Dock keeps
// them stable: navigate is a prop, acceptCorrectiveChip is useCallback([])).
const noopNavigate = (_to: string) => {};
const noopAccept = (_s: string, _q: string, _r?: string) => {};

function StreamingHarness({ initial }: { initial: ChatMessage[] }) {
  const [messages, setMessages] = useState(initial);
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          // Mirror CopilotDock's per-token update: rebuild only the streaming
          // message, keep every other message's object reference.
          setMessages((prev) =>
            prev.map((m) => (m.id === 'streaming' ? { ...m, text: `${m.text}字` } : m)),
          )
        }
      >
        append-token
      </button>
      {messages.map((m) => (
        <MessageRow
          key={m.id}
          message={m}
          navigate={noopNavigate}
          onAcceptCorrective={noopAccept}
          chipPending={false}
          chipAcked={false}
        />
      ))}
    </div>
  );
}

describe('CopilotDock MessageRow memoization (YUK-715)', () => {
  afterEach(cleanup);

  it('re-parses only the growing row when a streaming token appends', async () => {
    markdownRenders.length = 0;
    const initial: ChatMessage[] = [
      { id: 'a', role: 'ai', text: '静态消息一' },
      { id: 'b', role: 'user', text: '静态消息二' },
      { id: 'streaming', role: 'ai', text: '流式', streaming: true },
    ];
    render(<StreamingHarness initial={initial} />);

    // Each row parsed once on mount.
    expect(markdownRenders.filter((t) => t === '静态消息一').length).toBe(1);
    expect(markdownRenders.filter((t) => t === '静态消息二').length).toBe(1);
    expect(markdownRenders.filter((t) => t === '流式').length).toBe(1);
    const afterMount = markdownRenders.length;

    await userEvent.click(screen.getByText('append-token'));

    // Exactly one additional parse — the streaming row's new text. The two static
    // rows kept their object reference, so their memoized MessageRow skipped.
    expect(markdownRenders.length).toBe(afterMount + 1);
    expect(markdownRenders).toContain('流式字');
    expect(markdownRenders.filter((t) => t === '静态消息一').length).toBe(1);
    expect(markdownRenders.filter((t) => t === '静态消息二').length).toBe(1);
  });
});
