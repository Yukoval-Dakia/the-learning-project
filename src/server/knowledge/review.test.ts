import { dreaming_proposal, knowledge } from '@/db/schema';
import { MockLanguageModelV3 } from 'ai/test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { streamReviewTask } from './review';

function makeV3Usage() {
  return {
    inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 50, text: 50, reasoning: undefined },
  };
}

describe('streamReviewTask', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns a streaming Response and writes dreaming_proposal on tool call', async () => {
    const db = testDb();
    // Insert a knowledge node so the tree is not empty
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k1',
      name: '虚词',
      domain: 'wenyan',
      parent_id: null,
      base_mastery: 0,
      ai_delta_mastery: 0,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });

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

    const response = await streamReviewTask({ db, model: mockModel });
    expect(response).toBeInstanceOf(Response);
    expect(response.body).toBeTruthy();

    // Drain stream so tool execute fires.
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const proposals = await db.select().from(dreaming_proposal);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe('knowledge');
  });

  it('returns streaming Response even with no recent mistakes (empty input)', async () => {
    const db = testDb();
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

    const response = await streamReviewTask({ db, model: mockModel });
    expect(response).toBeInstanceOf(Response);
    const reader = response.body?.getReader();
    let total = '';
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += new TextDecoder().decode(value);
      }
    }
    expect(total).toContain('tree looks fine');
  });
});
