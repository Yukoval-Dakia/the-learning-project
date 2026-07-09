import { newId } from '@/core/ids';
import { event, learning_session, question_block, source_document } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
// YUK-577 — evaluateNudgeTrigger determinism (cut-1 ingestion). design §3.1/§3.2/§3.7.
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import type { NudgeConfig } from './nudge-config';
import { NUDGE_ACTION, NUDGE_DISMISSED_ACTION, evaluateNudgeTrigger } from './nudge-triggers';

const NOW = new Date('2026-07-07T04:00:00.000Z'); // noon Asia/Shanghai
const SHADOW_CFG: NudgeConfig = { enabled: false, dailyMax: 3, expiresHours: 24 };
const LIVE_CFG: NudgeConfig = { enabled: true, dailyMax: 3, expiresHours: 24 };

async function seedIngestion(opts: {
  sessionId: string;
  sourceDocId?: string;
  title?: string | null;
  blockCount: number;
  extractAt?: Date;
}): Promise<string> {
  const db = testDb();
  const now = opts.extractAt ?? NOW;
  const sourceDocId = opts.sourceDocId ?? `doc_${opts.sessionId}`;
  await db
    .insert(source_document)
    .values({ id: sourceDocId, title: opts.title ?? null, created_at: now, updated_at: now })
    .onConflictDoNothing();
  for (let i = 0; i < opts.blockCount; i++) {
    await db
      .insert(question_block)
      .values({
        id: `${opts.sessionId}_blk_${i}`,
        ingestion_session_id: opts.sessionId,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing();
  }
  // extract 域事件（直接 insert 绕 parseEvent —— 这是 seed 的触发源，非被测写入）。
  const extractId = `evt_extract_${opts.sessionId}`;
  await db.insert(event).values({
    id: extractId,
    session_id: opts.sessionId,
    actor_kind: 'agent',
    actor_ref: 'docx_text',
    action: 'extract',
    subject_kind: 'source_document',
    subject_id: sourceDocId,
    outcome: 'success',
    payload: { block_count: opts.blockCount },
    created_at: now,
  });
  return extractId;
}

async function seedNudge(causedBy: string, opts: { shadow: boolean; at?: Date }): Promise<string> {
  const id = newId();
  await writeEvent(testDb(), {
    id,
    actor_kind: 'agent',
    actor_ref: 'copilot_nudge_trigger',
    action: NUDGE_ACTION,
    subject_kind: 'learning_session',
    subject_id: `sess_${id}`,
    payload: {
      kind: 'ingestion_complete',
      headline: 'seeded',
      expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
      shadow: opts.shadow,
      in_active_session: false,
      evidence: {},
    },
    caused_by_event_id: causedBy,
    created_at: opts.at ?? NOW,
  });
  return id;
}

describe('evaluateNudgeTrigger — ingestion', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('fires with a titled flag-invariant headline + shadow=true when disabled', async () => {
    await seedIngestion({ sessionId: 'sess_A', title: '期中卷', blockCount: 12 });
    const d = await evaluateNudgeTrigger(
      testDb(),
      { kind: 'ingestion_complete', session_id: 'sess_A' },
      SHADOW_CFG,
      NOW,
    );
    expect(d.fire).toBe(true);
    if (!d.fire) throw new Error('unreachable');
    expect(d.event.payload.headline).toBe('我处理完《期中卷》，提取到 12 个题目片段');
    expect(d.event.payload.headline).not.toContain('收进'); // NEVER「收进 N 题」(should#3)
    expect(d.event.payload.shadow).toBe(true);
    expect(d.event.subject_kind).toBe('learning_session');
    expect(d.event.caused_by_event_id).toBe('evt_extract_sess_A');
  });

  it('degrades headline (drops 《》) when source_document has no title', async () => {
    await seedIngestion({ sessionId: 'sess_B', title: null, blockCount: 3 });
    const d = await evaluateNudgeTrigger(
      testDb(),
      { kind: 'ingestion_complete', session_id: 'sess_B' },
      SHADOW_CFG,
      NOW,
    );
    if (!d.fire) throw new Error('expected fire');
    expect(d.event.payload.headline).toBe('我处理完你上传的材料，提取到 3 个题目片段');
  });

  it('shadow=false when enabled (surfaceable)', async () => {
    await seedIngestion({ sessionId: 'sess_C', title: 't', blockCount: 1 });
    const d = await evaluateNudgeTrigger(
      testDb(),
      { kind: 'ingestion_complete', session_id: 'sess_C' },
      LIVE_CFG,
      NOW,
    );
    if (!d.fire) throw new Error('expected fire');
    expect(d.event.payload.shadow).toBe(false);
  });

  it('no_extract_event when the session has no extract event', async () => {
    const d = await evaluateNudgeTrigger(
      testDb(),
      { kind: 'ingestion_complete', session_id: 'ghost' },
      SHADOW_CFG,
      NOW,
    );
    expect(d).toEqual({ fire: false, reason: 'no_extract_event' });
  });

  it('no_blocks when 0 question_block extracted', async () => {
    await seedIngestion({ sessionId: 'sess_D', title: 't', blockCount: 0 });
    const d = await evaluateNudgeTrigger(
      testDb(),
      { kind: 'ingestion_complete', session_id: 'sess_D' },
      SHADOW_CFG,
      NOW,
    );
    expect(d).toEqual({ fire: false, reason: 'no_blocks' });
  });

  it('already_nudged (perf-layer dedup) when a nudge exists for the same extract event', async () => {
    const extractId = await seedIngestion({ sessionId: 'sess_E', title: 't', blockCount: 2 });
    await seedNudge(extractId, { shadow: true });
    const d = await evaluateNudgeTrigger(
      testDb(),
      { kind: 'ingestion_complete', session_id: 'sess_E' },
      SHADOW_CFG,
      NOW,
    );
    expect(d).toEqual({ fire: false, reason: 'already_nudged' });
  });

  it('daily_cap when enabled and dailyMax non-shadow nudges already fired today', async () => {
    await seedIngestion({ sessionId: 'sess_F', title: 't', blockCount: 2 });
    for (let i = 0; i < 3; i++) await seedNudge(`other_extract_${i}`, { shadow: false });
    const d = await evaluateNudgeTrigger(
      testDb(),
      { kind: 'ingestion_complete', session_id: 'sess_F' },
      LIVE_CFG,
      NOW,
    );
    expect(d).toEqual({ fire: false, reason: 'daily_cap' });
  });

  it('shadow rows do NOT count toward the daily cap (full observation in shadow window)', async () => {
    await seedIngestion({ sessionId: 'sess_G', title: 't', blockCount: 2 });
    for (let i = 0; i < 5; i++) await seedNudge(`shadow_extract_${i}`, { shadow: true });
    const d = await evaluateNudgeTrigger(
      testDb(),
      { kind: 'ingestion_complete', session_id: 'sess_G' },
      LIVE_CFG,
      NOW,
    );
    expect(d.fire).toBe(true); // 5 shadow nudges do not trip the cap
  });

  it('dismiss_fused when enabled and an ingestion nudge was dismissed today', async () => {
    await seedIngestion({ sessionId: 'sess_H', title: 't', blockCount: 2 });
    const priorNudge = await seedNudge('some_other_extract', { shadow: false });
    await writeEvent(testDb(), {
      id: newId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: NUDGE_DISMISSED_ACTION,
      subject_kind: 'event',
      subject_id: priorNudge,
      payload: {},
      caused_by_event_id: priorNudge,
      created_at: NOW,
    });
    const d = await evaluateNudgeTrigger(
      testDb(),
      { kind: 'ingestion_complete', session_id: 'sess_H' },
      LIVE_CFG,
      NOW,
    );
    expect(d).toEqual({ fire: false, reason: 'dismiss_fused' });
  });

  it('records in_active_session=true when an active practice session exists', async () => {
    await seedIngestion({ sessionId: 'sess_I', title: 't', blockCount: 2 });
    await testDb()
      .insert(learning_session)
      .values({ id: 'ls_active', type: 'tutor', status: 'active' });
    const d = await evaluateNudgeTrigger(
      testDb(),
      { kind: 'ingestion_complete', session_id: 'sess_I' },
      SHADOW_CFG,
      NOW,
    );
    if (!d.fire) throw new Error('expected fire');
    expect(d.event.payload.in_active_session).toBe(true);
  });
});
