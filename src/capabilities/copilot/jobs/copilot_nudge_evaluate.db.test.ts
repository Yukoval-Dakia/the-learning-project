import { newId } from '@/core/ids';
import { event, question_block, source_document } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
// YUK-577 — copilot_nudge_evaluate handler: write + idempotency + shadow + red-line. design §3.3/§3.7.
import { eq, ne } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { NUDGE_ACTION } from '../server/nudge-triggers';
import { runCopilotNudgeEvaluate } from './copilot_nudge_evaluate';

const NOW = new Date('2026-07-07T04:00:00.000Z');

async function seedIngestion(sessionId: string, blockCount: number, title = 't'): Promise<void> {
  const db = testDb();
  const docId = `doc_${sessionId}`;
  await db.insert(source_document).values({ id: docId, title, created_at: NOW, updated_at: NOW });
  for (let i = 0; i < blockCount; i++) {
    await db.insert(question_block).values({
      id: `${sessionId}_blk_${i}`,
      ingestion_session_id: sessionId,
      created_at: NOW,
      updated_at: NOW,
    });
  }
  await db.insert(event).values({
    id: `evt_extract_${sessionId}`,
    session_id: sessionId,
    actor_kind: 'agent',
    actor_ref: 'docx_text',
    action: 'extract',
    subject_kind: 'source_document',
    subject_id: docId,
    outcome: 'success',
    payload: {},
    created_at: NOW,
  });
}

async function countNudges(): Promise<number> {
  const rows = await testDb()
    .select({ id: event.id })
    .from(event)
    .where(eq(event.action, NUDGE_ACTION));
  return rows.length;
}

describe('runCopilotNudgeEvaluate', () => {
  const savedEnv = process.env.COPILOT_NUDGE_ENABLED;
  beforeEach(async () => {
    await resetDb();
    process.env.COPILOT_NUDGE_ENABLED = undefined;
    // biome-ignore lint/performance/noDelete: env must be genuinely absent for the default-OFF test
    delete process.env.COPILOT_NUDGE_ENABLED;
  });
  afterEach(() => {
    if (savedEnv === undefined) {
      // biome-ignore lint/performance/noDelete: restore absent state
      delete process.env.COPILOT_NUDGE_ENABLED;
    } else {
      process.env.COPILOT_NUDGE_ENABLED = savedEnv;
    }
  });

  it('writes exactly one nudge event (shadow=true by default OFF)', async () => {
    await seedIngestion('S1', 5);
    await runCopilotNudgeEvaluate(testDb(), { kind: 'ingestion_complete', session_id: 'S1' });
    const rows = await testDb().select().from(event).where(eq(event.action, NUDGE_ACTION));
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { shadow: boolean }).shadow).toBe(true);
    expect((rows[0].payload as { block_count?: number; kind: string }).kind).toBe(
      'ingestion_complete',
    );
    expect(rows[0].caused_by_event_id).toBe('evt_extract_S1');
  });

  it('is idempotent: two runs for the same completion → one nudge row', async () => {
    await seedIngestion('S2', 3);
    await runCopilotNudgeEvaluate(testDb(), { kind: 'ingestion_complete', session_id: 'S2' });
    await runCopilotNudgeEvaluate(testDb(), { kind: 'ingestion_complete', session_id: 'S2' });
    expect(await countNudges()).toBe(1);
  });

  it('RED LINE: writes ONLY the nudge action — no judge/attempt/review/correct events', async () => {
    await seedIngestion('S3', 2);
    await runCopilotNudgeEvaluate(testDb(), { kind: 'ingestion_complete', session_id: 'S3' });
    // Every event NOT the seeded extract must be the nudge action (no judge/attempt/mastery writes).
    const nonExtract = await testDb()
      .select({ action: event.action })
      .from(event)
      .where(ne(event.action, 'extract'));
    expect(nonExtract.every((r) => r.action === NUDGE_ACTION)).toBe(true);
    for (const forbidden of ['judge', 'attempt', 'review', 'correct']) {
      const rows = await testDb()
        .select({ id: event.id })
        .from(event)
        .where(eq(event.action, forbidden));
      expect(rows).toHaveLength(0);
    }
  });

  it('shadow=false when COPILOT_NUDGE_ENABLED=1 (surfaceable)', async () => {
    process.env.COPILOT_NUDGE_ENABLED = '1';
    await seedIngestion('S4', 4);
    await runCopilotNudgeEvaluate(testDb(), { kind: 'ingestion_complete', session_id: 'S4' });
    const rows = await testDb().select().from(event).where(eq(event.action, NUDGE_ACTION));
    expect((rows[0].payload as { shadow: boolean }).shadow).toBe(false);
  });

  it('no write when no blocks (empty extraction)', async () => {
    await seedIngestion('S5', 0);
    await runCopilotNudgeEvaluate(testDb(), { kind: 'ingestion_complete', session_id: 'S5' });
    expect(await countNudges()).toBe(0);
  });

  it('DB partial-unique index rejects a duplicate nudge for the same trigger source (23505)', async () => {
    await seedIngestion('S6', 2);
    await runCopilotNudgeEvaluate(testDb(), { kind: 'ingestion_complete', session_id: 'S6' });
    // A second nudge anchored to the SAME extract event, bypassing the handler's perf pre-check,
    // MUST be rejected by event_copilot_nudge_unique_idx — the correctness guard behind pg-boss
    // redelivery / concurrent delivery (perf SELECT dedup is only best-effort).
    await expect(
      writeEvent(testDb(), {
        id: newId(),
        actor_kind: 'agent',
        actor_ref: 'copilot_nudge_trigger',
        action: NUDGE_ACTION,
        subject_kind: 'learning_session',
        subject_id: 'S6',
        payload: {
          kind: 'ingestion_complete',
          headline: 'dup',
          expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
          shadow: true,
          in_active_session: false,
          evidence: {},
        },
        caused_by_event_id: 'evt_extract_S6',
      }),
    ).rejects.toThrow();
    expect(await countNudges()).toBe(1);
  });
});
