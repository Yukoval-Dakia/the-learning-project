import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, provider_attempt, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { type Mem0Like, createMemoryClient } from '@/server/ai/mem0/client';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { authorizeMemoryIngestReplay } from './memory-ingest-recovery-store';
import { claimMemoryIngest, memoryReconcileHandoffEventId } from './memory-reconcile-handoff-store';
import {
  buildMemoryEventIngestHandler,
  buildMemoryIngestOutboxPollHandler,
  buildMemoryIngestOutboxRecoverHandler,
} from './triggers';

const ANSWER_ACTIONS = [
  'experimental:assessment_attempt',
  'attempt',
  'review',
  'experimental:confirmation_command',
] as const;

function providerBoundary() {
  const add = vi.fn<Mem0Like['add']>(async () => ({
    results: [{ id: 'mem-1', memory: 'learner asks about elimination' }],
  }));
  const getAll = vi.fn<Mem0Like['getAll']>(async () => ({ results: [] }));
  const sdk: Mem0Like = {
    add,
    getAll,
    search: vi.fn(async () => ({ results: [] })),
    delete: vi.fn(async () => ({ message: 'ok' })),
    history: vi.fn(async () => []),
    get: vi.fn(async () => null),
  };
  const client = createMemoryClient({
    env: {
      DATABASE_URL: process.env.DATABASE_URL,
      ZHIPU_API_KEY: 'fake-test-key',
      DASHSCOPE_API_KEY: 'fake-test-key',
    },
    memoryFactory: () => sdk,
  });
  const sent: string[] = [];
  const boss = {
    send: vi.fn(async (_queue: string, data: object) => {
      sent.push((data as { event_id: string }).event_id);
      return null;
    }),
  };
  return { add, getAll, client, boss, sent };
}

function answerPayload(action: string) {
  const verbatim = `VERBATIM_${action}`;
  if (action === 'attempt')
    return {
      answer_md: verbatim,
      answer_image_refs: [] as string[],
      referenced_knowledge_ids: [] as string[],
    };
  if (action === 'review')
    return {
      fsrs_rating: 'good' as const,
      fsrs_state_after: {
        due: new Date('2026-11-07T00:00:00Z'),
        stability: 2,
        difficulty: 5,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review' as const,
        last_review: new Date('2026-11-06T00:00:00Z'),
      },
      user_response_md: verbatim,
      referenced_knowledge_ids: [] as string[],
    };
  return {
    response_md: verbatim,
    response_set: { entries: [{ kind: 'text', text_md: verbatim }] },
  };
}

describe('learner answer memory gate', () => {
  beforeEach(async () => {
    vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'off');
    await resetDb();
  });
  afterEach(() => vi.unstubAllEnvs());

  // @invariant security: learner answer events never reach Mem0 — the outbox poll, the hourly recovery floor and operator replay all refuse to push answer text to the provider, while a copilot ask still adds once with only its whitelisted fields
  // @fails-if let any path skip the learner-answer gate, widen the gate to non-answer events, or let the ask whitelist leak attachment fields; the zero-add counts, rejected grants and attachment-free payload assertions fail
  it('keeps learner answers out of Mem0 on poll, recovery and operator replay while the copilot ask adds once stripped of attachments', async () => {
    const db = testDb();
    const boundary = providerBoundary();
    // answer events' subject feeds the derivation lineage — the row must exist and be clean
    await db.insert(question).values({
      id: 'q-mem-gate',
      kind: 'derivation',
      prompt_md: '解方程 x+2=5',
      reference_md: 'x=3',
      source: 'web_sourced',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const write = (id: string, action: string, payload: Record<string, unknown>, stamped = false) =>
      writeEvent(db, {
        id,
        actor_kind: 'user',
        actor_ref: 'self',
        action,
        subject_kind: 'question',
        subject_id: 'q-mem-gate',
        outcome: 'success',
        affected_scopes: ['topic:algebra'],
        payload,
        ...(stamped ? { ingest_at: new Date() } : {}),
      });
    const answers = ANSWER_ACTIONS.map((action, index) => ({
      id: `evt-answer-${index}`,
      action,
    }));
    for (const row of answers) await write(row.id, row.action, answerPayload(row.action));
    const askId = 'evt-copilot-ask';
    await write(askId, 'experimental:copilot_user_ask', {
      user_message: '讲讲逆元怎么消元',
      surface: 'review_answer',
      session_id: 'session-mem-1',
      derivation_policy: 'allow',
      chip_kind: 'explain',
      review_answer: { response_md: 'VERBATIM_ASK_ATTACHMENT' },
      confirmation: {
        response_set: { entries: [{ kind: 'text', text_md: 'VERBATIM_ASK_CONFIRM' }] },
      },
    });
    const ingest = () =>
      buildMemoryEventIngestHandler(db, boundary.boss, { memoryClient: boundary.client });
    const answerIds = answers.map((row) => row.id);

    // Outbox poll: every pending row is enqueued, but the handler admits only the ask.
    await buildMemoryIngestOutboxPollHandler(db, boundary.boss)([]);
    expect(boundary.sent.slice().sort()).toEqual([...answerIds, askId].sort());
    for (const id of answerIds) await ingest()([{ data: { event_id: id } }]);
    expect(boundary.add).not.toHaveBeenCalled();
    await ingest()([{ data: { event_id: askId } }]);
    expect(boundary.add).toHaveBeenCalledOnce();
    const sentText = boundary.add.mock.calls[0][0] as string;
    const sentPayload = (JSON.parse(sentText) as { payload: Record<string, unknown> }).payload;
    expect(sentPayload.user_message).toBe('讲讲逆元怎么消元');
    expect(Object.keys(sentPayload).sort()).toEqual(
      ['chip_kind', 'derivation_policy', 'session_id', 'surface', 'user_message'].sort(),
    );
    expect(sentText).not.toContain('VERBATIM');

    // Recovery floor: reopened rows are re-enqueued, yet the gate still refuses the paid add.
    await db.update(event).set({ ingest_at: null }).where(inArray(event.id, answerIds));
    boundary.sent.length = 0;
    await buildMemoryIngestOutboxRecoverHandler(db, boundary.boss)([]);
    expect(boundary.sent.slice().sort()).toEqual(answerIds.slice().sort());
    for (const id of answerIds) await ingest()([{ data: { event_id: id } }]);
    expect(boundary.add).toHaveBeenCalledOnce();
    expect(await db.select().from(provider_attempt)).toHaveLength(1);

    // Operator replay: no answer source may receive a grant; a stalled non-answer source still can.
    for (const id of answerIds) {
      await expect(
        authorizeMemoryIngestReplay(db, {
          sourceEventId: id,
          requestId: randomUUID(),
          expectedFenceId: memoryReconcileHandoffEventId('add_started', id),
          operator: 'operator-test',
          reason: 'attempted replay of a learner answer',
          allowPaidReplay: true,
        }),
      ).rejects.toThrow(/existing user event/);
    }
    const stalledAskId = 'evt-ask-stalled';
    await write(
      stalledAskId,
      'experimental:copilot_user_ask',
      { user_message: '再讲一遍逆元' },
      true,
    );
    await claimMemoryIngest(db, stalledAskId);
    const fence = memoryReconcileHandoffEventId('add_started', stalledAskId);
    await db
      .update(event)
      .set({ created_at: new Date(Date.now() - 180_000) })
      .where(eq(event.id, fence));
    const grant = await authorizeMemoryIngestReplay(db, {
      sourceEventId: stalledAskId,
      requestId: randomUUID(),
      expectedFenceId: fence,
      operator: 'operator-test',
      reason: 'operator replay of a stalled copilot add',
      allowPaidReplay: true,
    });
    expect(grant.source_event_id).toBe(stalledAskId);
  });
});
