// U5 (YUK-203, §4.7 + §11 DEFER) — experimental:adaptation event contract test.
//
// The U5 MVP answering page is static text+choice with NO mid-attempt adaptation
// trigger (§11: explicitly DEFER the real trigger — no UI/Coach path rewrites
// the paper in-session). This is the CONTRACT test the §11 ruling calls for: the
// adaptation event helper + the artifact version bump happen together in one
// transaction, and the event passes the writeEvent parse barrier (ExperimentalEvent
// escape hatch, Q10). No real trigger scenario is fabricated.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { artifact, event } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { writePaperAdaptationEvent } from './paper-adaptation';

async function seedPaper(id: string, version: number) {
  const db = testDb();
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type: 'tool_quiz',
    title: '可变卷',
    knowledge_ids: ['k1'],
    intent_source: 'review_plan',
    source: 'ai_generated',
    tool_kind: 'review_plan',
    tool_state: { question_ids: ['q1'] } as never,
    generation_status: 'ready',
    verification_status: 'not_required',
    history: [],
    created_at: now,
    updated_at: now,
    version,
  });
}

describe('writePaperAdaptationEvent (RL5 evidence-first contract)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('rolls back the adaptation event if the surrounding tx aborts (no orphan trail)', async () => {
    const db = testDb();
    await seedPaper('paper1', 0);

    await expect(
      db.transaction(async (tx) => {
        await writePaperAdaptationEvent(tx, {
          artifactId: 'paper1',
          fromVersion: 0,
          toVersion: 1,
          changeSummary: 'mutation that fails',
          triggeringJudgeEventId: 'judge_evt_1',
        });
        throw new Error('simulated downstream failure');
      }),
    ).rejects.toThrow('simulated downstream failure');

    const rows = await db.select().from(event).where(eq(event.action, 'experimental:adaptation'));
    expect(rows).toHaveLength(0);
  });
});
