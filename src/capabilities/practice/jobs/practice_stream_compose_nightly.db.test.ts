// YUK-361 Phase 4 (Task 9) — 夜间预产 job handler 测试：runStreamComposeNightly 为今天
// 物化流（added_by=composer_nightly）+ 幂等（二次跑 no-op）。
//
// LLM 不命中 live endpoint：本测试不种非到期 samplable 候选（只种到期题），故 softmax 路径
// samplable=0、不调 SelectionOrchestratorTask（与 stream.db.test 的 due-only 路径同理）。

import { material_fsrs_state, practice_stream_item, question } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runStreamComposeNightly } from './practice_stream_compose_nightly';

const TODAY = new Date().toLocaleDateString('sv-SE');

async function seedDueQuestion(): Promise<string> {
  const qid = createId();
  const now = new Date();
  await testDb().insert(question).values({
    id: qid,
    kind: 'choice',
    prompt_md: '题干',
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

describe('practice_stream_compose_nightly handler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('为今天物化流（added_by=composer_nightly），返回 date+added', async () => {
    const dueId = await seedDueQuestion();

    const result = await runStreamComposeNightly(testDb());
    expect(result.date).toBe(TODAY);
    expect(result.added).toBeGreaterThan(0);

    const rows = await testDb()
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, TODAY))
      .orderBy(asc(practice_stream_item.position));
    expect(rows.map((r) => r.ref_id)).toContain(dueId);
    for (const r of rows) expect(r.added_by).toBe('composer_nightly');
  });

  it('幂等：跑两次第二次 no-op（added=0、行数不变）', async () => {
    await seedDueQuestion();

    const first = await runStreamComposeNightly(testDb());
    expect(first.added).toBeGreaterThan(0);
    const rowsAfterFirst = await testDb()
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, TODAY));

    const second = await runStreamComposeNightly(testDb());
    expect(second.added).toBe(0);
    const rowsAfterSecond = await testDb()
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, TODAY));
    expect(rowsAfterSecond.length).toBe(rowsAfterFirst.length);
  });
});
