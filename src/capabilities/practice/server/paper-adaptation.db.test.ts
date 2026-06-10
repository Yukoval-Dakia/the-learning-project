// U5 (YUK-203, §4.7 + §11 DEFER) — experimental:adaptation event contract test.
//
// The U5 MVP answering page is static text+choice with NO mid-attempt adaptation
// trigger (§11: explicitly DEFER the real trigger — no UI/Coach path rewrites
// the paper in-session). This is the CONTRACT test the §11 ruling calls for: the
// adaptation event helper + the artifact version bump happen together in one
// transaction, and the event passes the writeEvent parse barrier (ExperimentalEvent
// escape hatch, Q10). No real trigger scenario is fabricated.

import { artifact, event } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
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

  it('writes experimental:adaptation in the SAME tx as the artifact version bump', async () => {
    const db = testDb();
    await seedPaper('paper1', 0);

    await db.transaction(async (tx) => {
      // Mutate the paper (version 0 → 1) AND emit the adaptation event together.
      await tx
        .update(artifact)
        .set({ version: sql`${artifact.version} + 1`, updated_at: new Date() })
        .where(eq(artifact.id, 'paper1'));
      await writePaperAdaptationEvent(tx, {
        artifactId: 'paper1',
        fromVersion: 0,
        toVersion: 1,
        changeSummary: 'swapped slot 2 for an easier variant',
        triggeringJudgeEventId: 'judge_evt_1',
      });
    });

    const rows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'experimental:adaptation'), eq(event.subject_kind, 'artifact')));
    expect(rows).toHaveLength(1);
    expect(rows[0].subject_id).toBe('paper1');
    expect(rows[0].caused_by_event_id).toBe('judge_evt_1');
    const payload = rows[0].payload as {
      from_version: number;
      to_version: number;
      change_summary: string;
    };
    expect(payload.from_version).toBe(0);
    expect(payload.to_version).toBe(1);
    expect(payload.change_summary).toContain('variant');

    // The artifact version actually advanced (mutation + event are consistent).
    const paper = (await db.select().from(artifact).where(eq(artifact.id, 'paper1')))[0];
    expect(paper.version).toBe(1);
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
