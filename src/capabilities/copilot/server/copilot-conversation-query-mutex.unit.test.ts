import { describe, expect, it, vi } from 'vitest';
import {
  resetCopilotConversationQueryMutexForTests,
  withCopilotConversationQueryMutex,
} from './copilot-conversation-query-mutex';

describe('withCopilotConversationQueryMutex', () => {
  it('runs fn serially for the same session id', async () => {
    resetCopilotConversationQueryMutexForTests();
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const p1 = withCopilotConversationQueryMutex('ls_a', async () => {
      order.push(1);
      await gate;
      order.push(2);
    });
    await vi.waitFor(() => expect(order).toEqual([1]));
    const p2 = withCopilotConversationQueryMutex('ls_a', async () => {
      order.push(3);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([1]);
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3]);
  });
});
