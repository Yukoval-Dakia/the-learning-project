import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { streamReviewTask } from './review';

function makeMockDb() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const knowledgeRows = [
    { id: 'k1', name: '虚词', domain: 'wenyan', parent_id: null, archived_at: null, version: 0 },
  ];
  const mistakeRows: Record<string, unknown>[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        first: async () => null,
        all: async () => {
          if (/from knowledge/i.test(sql)) return { results: knowledgeRows };
          if (/from mistake/i.test(sql)) return { results: mistakeRows };
          return { results: [] };
        },
        run: async () => ({ success: true }),
      };
    },
  }));
  return {
    db: { prepare } as unknown as D1Database,
    calls,
  };
}

function makeV3Usage() {
  return {
    inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 50, text: 50, reasoning: undefined },
  };
}

describe('streamReviewTask', () => {
  it('returns a streaming Response and writes dreaming_proposal on tool call', async () => {
    const mockModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'tc1',
              toolName: 'write_proposal',
              input: JSON.stringify({
                payload: { mutation: 'archive', node_id: 'k1', expected_version: 0 },
                reasoning: 'k1 has no recent mistakes; safe to archive',
              }),
            });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'end_turn' },
              usage: makeV3Usage(),
            });
            controller.close();
          },
        }),
      }),
    });

    const { db, calls } = makeMockDb();
    const env = {
      DB: db,
      INTERNAL_TOKEN: 'test',
      ANTHROPIC_API_KEY: 'test',
    } as never;

    const response = await streamReviewTask({ env, model: mockModel });
    expect(response).toBeInstanceOf(Response);
    expect(response.body).toBeTruthy();

    // Drain stream so onStepFinish fires.
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const insert = calls.find((c) => /insert into dreaming_proposal/i.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert?.binds[1]).toBe('knowledge'); // kind
  });

  it('returns streaming Response even with no recent mistakes (empty input)', async () => {
    const mockModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't0' });
            controller.enqueue({ type: 'text-delta', id: 't0', delta: 'tree looks fine' });
            controller.enqueue({ type: 'text-end', id: 't0' });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'end_turn' },
              usage: makeV3Usage(),
            });
            controller.close();
          },
        }),
      }),
    });

    const { db } = makeMockDb();
    const env = {
      DB: db,
      INTERNAL_TOKEN: 'test',
      ANTHROPIC_API_KEY: 'test',
    } as never;

    const response = await streamReviewTask({ env, model: mockModel });
    expect(response).toBeInstanceOf(Response);
    const reader = response.body!.getReader();
    let total = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += new TextDecoder().decode(value);
    }
    expect(total).toContain('tree looks fine');
  });
});
