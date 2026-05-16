import { newId } from '@/core/ids';
import { dreaming_proposal, event, knowledge } from '@/db/schema';
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

async function seedKnowledgeNode(id: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: '虚词',
    domain: 'wenyan',
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedAttemptWithJudge(opts: {
  attemptId: string;
  questionId: string;
  knowledgeIds: string[];
  primary_category?: string;
  analysis_md?: string;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(event).values({
    id: opts.attemptId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: opts.questionId,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: opts.knowledgeIds,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
  await db.insert(event).values({
    id: newId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: opts.attemptId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: opts.primary_category ?? 'concept',
        secondary_categories: [],
        analysis_md: opts.analysis_md ?? 'analysis',
        confidence: 0.8,
      },
      referenced_knowledge_ids: opts.knowledgeIds,
    },
    caused_by_event_id: opts.attemptId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });
}

describe('streamReviewTask', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns a streaming Response and writes dreaming_proposal on tool call', async () => {
    const db = testDb();
    await seedKnowledgeNode('k1');
    // Seed an attempt+judge event pair so review has recent-mistakes context
    await seedAttemptWithJudge({
      attemptId: 'attempt_e1',
      questionId: 'q1',
      knowledgeIds: ['k1'],
      primary_category: 'memory',
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

  it('passes recent-mistakes shape projected from event stream into the LLM prompt', async () => {
    const db = testDb();
    await seedKnowledgeNode('k1');
    await seedAttemptWithJudge({
      attemptId: 'attempt_capture',
      questionId: 'q_capture',
      knowledgeIds: ['k1'],
      primary_category: 'concept',
      analysis_md: 'event-stream analysis',
    });

    let capturedPrompt = '';
    const mockModel = new MockLanguageModelV3({
      doStream: async (options: unknown) => {
        const opts = options as { prompt?: unknown };
        capturedPrompt = JSON.stringify(opts.prompt ?? '');
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'end_turn' },
                usage: makeV3Usage(),
              });
              controller.close();
            },
          }),
        };
      },
    });

    const response = await streamReviewTask({ db, model: mockModel });
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
    // Prompt JSON should now contain mistake-shape data sourced from the event stream
    expect(capturedPrompt).toContain('attempt_capture'); // id from event projection
    expect(capturedPrompt).toContain('q_capture'); // question_id
    expect(capturedPrompt).toContain('concept'); // cause.primary_category
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
