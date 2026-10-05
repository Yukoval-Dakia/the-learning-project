import { eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { handleRejudge } from '@/capabilities/practice/jobs/rejudge';
import { createNativeAppeal } from '@/capabilities/practice/server/assessment/appeal';
import { StateSnapshotExperimental } from '@/core/schema/event/state-snapshot';
import { event, question } from '@/db/schema';
import { loadNativeReviewOccurrences } from '@/kernel/read-models/assessment-review-occurrences';
import {
  nativeAttemptOutcome,
  resolveVerdictsForNativeAttempts,
} from '@/kernel/read-models/assessment-verdict';
import { nativeAppealFixture } from '../../../tests/fixtures/native-appeal';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';
import { buildBackupArchive } from './archive';
import { buildMistakesCsv, buildReviewEventsCsv, csvEscape } from './csv';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

async function exportedSnapshot() {
  const { stream } = await buildBackupArchive({ db: testDb(), r2: memR2(), includeAssets: false });
  const files = unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()));
  const decode = (name: string) => new TextDecoder().decode(files[name]);
  const tables = z
    .record(z.string(), z.array(z.record(z.string(), z.unknown())))
    .parse(JSON.parse(decode('data.json')));
  const mistakes = decode('mistakes.csv');
  const reviews = decode('review_events.csv');
  expect(buildMistakesCsv(tables)).toBe(mistakes);
  expect(buildReviewEventsCsv(tables)).toBe(reviews);
  return { tables, mistakes, reviews };
}

describe('native CSV database snapshot parity', () => {
  it('exports an offline recorded native attempt with frozen content, independent user rating, and historical snapshot state', async () => {
    const db = testDb();
    const f = await nativeAppealFixture(db, {
      userRating: 'good',
      now: new Date('2026-10-01T08:00:00Z'),
    });
    const [anchor] = await db.select().from(event).where(eq(event.id, f.attemptId));
    const verdicts = await resolveVerdictsForNativeAttempts(db, [anchor]);
    expect(nativeAttemptOutcome(verdicts.get(f.attemptId))).toBe('failure');
    const occurrences = await loadNativeReviewOccurrences(db);
    expect(occurrences).toHaveLength(1);
    const occurrence = occurrences[0];
    expect(occurrence.rating).toBe('good');
    await db
      .update(question)
      .set({
        prompt_md: '编辑后的题目不得进入历史CSV',
        reference_md: '编辑后的答案',
        knowledge_ids: [],
        difficulty: 5,
      })
      .where(eq(question.id, f.questionId));
    const [snapshot] = await db
      .select()
      .from(event)
      .where(eq(event.id, `${occurrence.settlementId}:snapshot:fsrs`));
    const card = StateSnapshotExperimental.shape.payload.parse(snapshot.payload).fsrs_snapshots[0];
    const result = await exportedSnapshot();
    expect(result.mistakes).toContain(f.attemptId);
    expect(result.mistakes).toContain('顺流18 km/h、逆流12 km/h');
    expect(result.mistakes).toContain('列方程与消元');
    expect(result.mistakes).toContain('v+c=18，v-c=12，相加消去水速得 v=15 km/h。');
    expect(result.mistakes).toContain(',incorrect,incorrect');
    expect(result.mistakes).not.toContain('编辑后的');
    expect(result.reviews.split('\n')).toHaveLength(2);
    const values = result.reviews.split('\n')[1].split(',');
    expect(values[0]).toBe(occurrence.id);
    expect(values[1]).toBe(occurrence.occurredAt.toISOString());
    expect(values[5]).toBe('good');
    expect(values[10]).toBe(csvEscape(card.after.stability));
    expect(values[12]).toBe(card.after.due.toISOString());
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('retains a corrected original mistake and counts retained user scheduling once through actual appeal settlement', async () => {
    const db = testDb();
    const f = await nativeAppealFixture(db, { userRating: 'good' });
    const appealId = await createNativeAppeal(db, {
      evaluation_id: f.original.evaluation_id,
      reason_md: '请复核原始方程、消元步骤和单位，保留原题。',
    });
    f.setPoints(1);
    expect(await handleRejudge(db, { appeal_event_id: appealId })).toMatchObject({
      status: 'reassessed',
      effect: 'applied',
    });
    const occurrences = await loadNativeReviewOccurrences(db);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ rating: 'good', outcome: 'success' });
    const result = await exportedSnapshot();
    expect(result.mistakes).toContain(f.attemptId);
    expect(result.mistakes).toContain(',1,correct,incorrect');
    expect(result.reviews.split('\n')).toHaveLength(2);
    expect(result.reviews).toContain(`assessment:${f.original.evaluation_group_id},`);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it('matches live occurrence deduplication when an earlier appeal replays a later group', async () => {
    const db = testDb();
    const first = await nativeAppealFixture(db, { now: new Date('2026-10-01T08:00:00Z') });
    const later = await nativeAppealFixture(db, {
      knowledgeId: first.knowledgeId,
      now: new Date('2026-10-02T08:00:00Z'),
    });
    const appealId = await createNativeAppeal(db, {
      evaluation_id: first.original.evaluation_id,
      reason_md: '复核原式并重放后续调度。',
    });
    later.setPoints(1);
    expect(await handleRejudge(db, { appeal_event_id: appealId })).toMatchObject({
      status: 'reassessed',
    });
    const occurrences = await loadNativeReviewOccurrences(db);
    expect(occurrences).toHaveLength(2);
    const result = await exportedSnapshot();
    expect(result.reviews.split('\n')).toHaveLength(3);
    for (const occurrence of occurrences)
      expect(result.reviews).toContain(`${occurrence.id},${occurrence.occurredAt.toISOString()},`);
    expect(result.reviews).toContain('2026-10-02T08:00:00.000Z');
  });
});
