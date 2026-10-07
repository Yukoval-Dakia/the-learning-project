import { appendFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { event } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { getCurrentFailureAttempts, getFailureAttempts } from './failure-attempts';

const AT = new Date('2026-10-06T02:00:00.000Z');
beforeEach(resetDb);

async function history(questionId: string, corrected: number, failures: number) {
  const db = testDb();
  const retained = Array.from(
    { length: failures },
    (_, i) => `${questionId}_a_${String(i).padStart(4, '0')}`,
  );
  const changed = Array.from(
    { length: corrected },
    (_, i) => `${questionId}_z_${String(i).padStart(4, '0')}`,
  );
  // Reverse physical insertion and same timestamps prove the id cursor owns ordering.
  await db.insert(event).values(
    [...retained, ...changed].reverse().map((id) => ({
      id,
      actor_kind: 'user' as const,
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question' as const,
      subject_id: questionId,
      outcome: 'failure',
      payload: {
        answer_md: `多行方程推导：${'先列条件再消元，检查符号与单位。'.repeat(24)}\n原始答卷保持不变。`,
        answer_image_refs: ['image_original'],
        referenced_knowledge_ids: ['kc_algebra', 'kc_units'],
        reasoning_trace: '原答由嵌套条件推出方程，改判不得删原证据。',
      },
      created_at: AT,
    })),
  );
  const corrections: Array<typeof event.$inferInsert> = changed.flatMap((attemptId) => [
    {
      id: `old_${attemptId}`,
      actor_kind: 'agent',
      actor_ref: 'grade',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      caused_by_event_id: attemptId,
      outcome: 'success',
      payload: {
        coarse_outcome: 'incorrect',
        cause: {
          primary_category: 'concept',
          analysis_md: '原判',
          secondary_categories: [],
          confidence: 0.7,
        },
        referenced_knowledge_ids: ['kc_algebra'],
      },
      created_at: AT,
    },
    {
      id: `new_${attemptId}`,
      actor_kind: 'agent',
      actor_ref: 'rejudge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: attemptId,
      caused_by_event_id: `appeal_${attemptId}`,
      outcome: 'success',
      payload: {
        coarse_outcome: 'correct',
        cause: {
          primary_category: 'method',
          analysis_md: '复核原答的消元步骤成立，原判失误。',
          secondary_categories: [],
          confidence: 0.95,
        },
        referenced_knowledge_ids: ['kc_algebra'],
      },
      created_at: new Date(AT.getTime() + 1000),
    },
    {
      id: `correct_${attemptId}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: `old_${attemptId}`,
      outcome: 'success',
      payload: {
        correction_kind: 'supersede',
        replacement_event_id: `new_${attemptId}`,
        reason_md: '复核原答',
        affected_refs: [{ kind: 'question', id: questionId }],
      },
      created_at: new Date(AT.getTime() + 2000),
    },
  ]);
  if (corrections.length) await db.insert(event).values(corrections);
  return retained;
}

async function trace<T>(read: () => Promise<T>) {
  const client = testDb().$client;
  const originalDebug = client.options.debug;
  const queries: Array<{ query: string; parameters: unknown[] }> = [];
  client.options.debug = (_connection, query, parameters) => {
    queries.push({ query, parameters });
  };
  try {
    const result = await read();
    const pages = queries.filter(
      ({ query, parameters }) =>
        query.startsWith('select ') &&
        query.includes('from "event"') &&
        parameters.includes('experimental:assessment_attempt') &&
        parameters.includes('question'),
    );
    const logPath = process.env.YUK1047_QUERY_TRACE_PATH;
    if (logPath)
      appendFileSync(
        logPath,
        `${JSON.stringify({ test: expect.getState().currentTestName, pages, resultCount: Array.isArray(result) ? result.length : null })}\n`,
      );
    console.info(
      'YUK-1047 current failure query boundary',
      JSON.stringify(pages.map(({ query, parameters }) => ({ query, parameters }))),
    );
    return { result, pages };
  } finally {
    client.options.debug = originalDebug;
  }
}
function bound(pages: Array<{ query: string; parameters: unknown[] }>, max: number) {
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    const position = page.query.match(/limit \$(\d+)/)?.[1];
    expect.soft(position, page.query).toBeDefined();
    if (position) expect(Number(page.parameters[Number(position) - 1])).toBeLessThanOrEqual(max);
    expect.soft(page.query).not.toMatch(/\boffset\b/);
  }
}

describe('bounded current failure history (YUK-1047)', () => {
  it('fills a requested limit across the superseded-correct prefix with bounded keyset queries', async () => {
    const retained = await history('q_a', 45, 20);
    const { result, pages } = await trace(() =>
      getCurrentFailureAttempts(testDb(), { questionIds: ['q_a'], limit: 2 }),
    );
    expect(result.map((row) => row.attempt_event_id)).toEqual(retained.toReversed().slice(0, 2));
    bound(pages, 6);
    expect(pages.length).toBeGreaterThan(1);
    expect(
      pages
        .slice(1)
        .every(({ query }) => query.includes('"created_at" <') && query.includes('"id" <')),
    ).toBe(true);
    expect(
      (await getFailureAttempts(testDb(), { questionIds: ['q_a'], limit: 2 })).map(
        (row) => row.attempt_event_id,
      ),
    ).toEqual(['q_a_z_0044', 'q_a_z_0043']);
  });

  it('fills each question after correct regrades instead of consuming its quota with corrected rows', async () => {
    const a = await history('q_a', 19, 7);
    const b = await history('q_b', 2, 3);
    const { result, pages } = await trace(() =>
      getCurrentFailureAttempts(testDb(), {
        questionIds: ['q_a', 'q_b'],
        perQuestionLimit: 2,
        limit: 1,
      }),
    );
    expect(
      result.filter((row) => row.question_id === 'q_a').map((row) => row.attempt_event_id),
    ).toEqual(a.toReversed().slice(0, 2));
    expect(
      result.filter((row) => row.question_id === 'q_b').map((row) => row.attempt_event_id),
    ).toEqual(b.toReversed().slice(0, 2));
    expect(new Set(result.map((row) => row.attempt_event_id)).size).toBe(4);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.query).toContain('row_number() OVER (PARTITION BY');
      expect(page.query).not.toMatch(/\boffset\b/);
      expect(Number(page.parameters.at(-1)) - Number(page.parameters.at(-2))).toBe(6);
    }
  });

  it('pages forward at identical timestamps without duplicate or omitted current failures', async () => {
    const retained = await history('q_same', 8, 23);
    const all: string[] = [];
    let afterCreatedAt: Date | undefined;
    let afterEventId: string | undefined;
    for (;;) {
      const { result, pages } = await trace(() =>
        getCurrentFailureAttempts(testDb(), {
          limit: 5,
          order: 'asc',
          since: AT,
          afterCreatedAt,
          afterEventId,
        }),
      );
      bound(pages, 15);
      if (!result.length) break;
      all.push(...result.map((row) => row.attempt_event_id));
      const last = result.at(-1);
      afterCreatedAt = last?.created_at;
      afterEventId = last?.attempt_event_id;
    }
    expect(all).toEqual(retained);
    expect(new Set(all).size).toBe(23);
  });

  it('retains explicit full-history results while bounding every database page', async () => {
    const retained = await history('q_full', 11, 325);
    const { result, pages } = await trace(() =>
      getCurrentFailureAttempts(testDb(), { limit: null }),
    );
    expect(result.map((row) => row.attempt_event_id)).toEqual(retained.toReversed());
    bound(pages, 300);
    expect(pages.length).toBeGreaterThan(1);
  });

  it('does not query for zero/negative limits and honours review and time boundaries', async () => {
    await history('q_filter', 2, 6);
    await testDb()
      .insert(event)
      .values({
        id: 'review_failed',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'review',
        subject_kind: 'question',
        subject_id: 'q_filter',
        outcome: 'failure',
        payload: {
          fsrs_rating: 'again',
          user_response_md: '检查约分条件',
          referenced_knowledge_ids: ['kc_algebra'],
        },
        created_at: new Date(AT.getTime() + 10),
      });
    expect(
      (await trace(() => getCurrentFailureAttempts(testDb(), { limit: 0 }))).pages,
    ).toHaveLength(0);
    expect(
      (await trace(() => getCurrentFailureAttempts(testDb(), { limit: -1 }))).pages,
    ).toHaveLength(0);
    expect(
      await getCurrentFailureAttempts(testDb(), { since: new Date(AT.getTime() + 1), limit: 2 }),
    ).toEqual([]);
    expect(
      await getCurrentFailureAttempts(testDb(), {
        includeReviewFailures: true,
        since: new Date(AT.getTime() + 1),
        limit: 2,
      }),
    ).toMatchObject([{ attempt_event_id: 'review_failed' }]);
  });
});
