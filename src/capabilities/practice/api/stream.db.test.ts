// M2 (YUK-316) — 流 API 行为：lazy compose（仅今日）、状态机推进、双日隔离、
// recompose 保留非 pending 项。composer 混排规则本体在 stream-composer.unit.test.ts。

import { material_fsrs_state, practice_stream_item, question } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET, PATCH, POST } from './stream';

const TODAY = new Date().toLocaleDateString('sv-SE');

async function seedDueQuestion(): Promise<string> {
  const qid = createId();
  const now = new Date();
  await testDb().insert(question).values({
    id: qid,
    kind: 'choice',
    prompt_md: '下列「之」用作取独的是？',
    reference_md: 'B',
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    figures: [],
    image_refs: [],
    structured: null,
    metadata: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await testDb()
    .insert(material_fsrs_state)
    .values({
      id: createId(),
      subject_kind: 'question',
      subject_id: qid,
      state: {
        due: now,
        stability: 1,
        difficulty: 5,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review' as const,
        last_review: now,
      },
      due_at: new Date(now.getTime() - 3600_000),
      last_review_event_id: null,
      updated_at: now,
    });
  return qid;
}

function getReq(date?: string): Request {
  const qs = date ? `?date=${date}` : '';
  return new Request(`http://t/api/practice/stream${qs}`);
}

describe('practice stream API', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('GET today lazy-composes from due signal and persists the stream', async () => {
    const qid = await seedDueQuestion();
    const res = await GET(getReq('today'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      date: string;
      items: Array<{ ref_id: string; source: string; status: string; position: number }>;
      progress: { done: number; total: number };
      opening_line: string;
    };
    expect(body.date).toBe(TODAY);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].ref_id).toBe(qid);
    expect(body.items[0].source).toBe('decay');
    expect(body.items[0].status).toBe('pending');
    expect(body.progress).toEqual({ done: 0, total: body.items.length });

    // 第二次 GET 读到的是同一份物化流（不重复 compose）。
    const res2 = await GET(getReq());
    const body2 = (await res2.json()) as { items: Array<{ ref_id: string }> };
    expect(body2.items.map((i) => i.ref_id)).toEqual(body.items.map((i) => i.ref_id));
  });

  it('GET a past date never lazy-composes (历史日期不凭空生流)', async () => {
    await seedDueQuestion();
    const res = await GET(getReq('2020-01-01'));
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
    const rows = await testDb()
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, '2020-01-01'));
    expect(rows).toHaveLength(0);
  });

  it('PATCH advances item status and rejects illegal transitions (done 是终态)', async () => {
    await seedDueQuestion();
    const seeded = (await (await GET(getReq())).json()) as { items: Array<{ id: string }> };
    const itemId = seeded.items[0].id;

    const patch = (status: string) =>
      PATCH(
        new Request(`http://t/api/practice/stream/items/${itemId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        }),
        { id: itemId },
      );

    expect((await patch('in_progress')).status).toBe(200);
    expect((await patch('done')).status).toBe(200);
    // done → pending 非法
    const illegal = await patch('pending');
    expect(illegal.status).toBe(409);

    const view = (await (await GET(getReq())).json()) as { progress: { done: number } };
    expect(view.progress.done).toBe(1);
  });

  it('skipped 可捡回（skipped → pending）', async () => {
    await seedDueQuestion();
    const seeded = (await (await GET(getReq())).json()) as { items: Array<{ id: string }> };
    const itemId = seeded.items[0].id;
    const patch = (status: string) =>
      PATCH(new Request('http://t/x', { method: 'PATCH', body: JSON.stringify({ status }) }), {
        id: itemId,
      });
    expect((await patch('skipped')).status).toBe(200);
    expect((await patch('pending')).status).toBe(200);
  });

  it('POST recompose keeps non-pending rows and re-adds from signals without duplicating refs', async () => {
    const qid = await seedDueQuestion();
    const seeded = (await (await GET(getReq())).json()) as { items: Array<{ id: string }> };
    const itemId = seeded.items[0].id;
    // 做完第一项
    await PATCH(
      new Request('http://t/x', { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }),
      { id: itemId },
    );

    const res = await POST(
      new Request('http://t/api/practice/stream/recompose', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      added: number;
      items: Array<{ ref_id: string; status: string }>;
    };
    // done 行保留；同 ref 不重复排入（date+ref 唯一）
    const sameRef = body.items.filter((i) => i.ref_id === qid);
    expect(sameRef).toHaveLength(1);
    expect(sameRef[0].status).toBe('done');
  });
});
