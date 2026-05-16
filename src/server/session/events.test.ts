import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { parseEvent } from '@/core/schema/event';
import { db } from '@/db/client';
import { event, learning_session } from '@/db/schema';
import { writeSessionEvent } from './events';

async function seedIngestionSession(): Promise<string> {
  const id = createId();
  const now = new Date();
  await db.insert(learning_session).values({
    id,
    type: 'ingestion',
    status: 'extracting',
    source_document_id: createId(),
    source_asset_ids: ['asset_a'],
    entrypoint: 'vision_single',
    warnings: [],
    error_message: null,
    started_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

describe('writeSessionEvent', () => {
  it('writes an event matching ExtractSourceDocument shape (success)', async () => {
    const sessionId = await seedIngestionSession();
    const sourceDocId = createId();

    const eventId = await writeSessionEvent(db, {
      session_id: sessionId,
      action: 'extract',
      subject_kind: 'source_document',
      subject_id: sourceDocId,
      actor_kind: 'agent',
      actor_ref: 'tencent_ocr',
      outcome: 'success',
      payload: {
        structured_block_ids: ['blk_1', 'blk_2'],
        layout_quality: 'structured',
        warnings: [],
      },
    });

    expect(eventId).toBeTruthy();

    const rows = await db.select().from(event).where(eq(event.id, eventId));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.session_id).toBe(sessionId);
    expect(row.action).toBe('extract');
    expect(row.subject_kind).toBe('source_document');
    expect(row.subject_id).toBe(sourceDocId);
    expect(row.actor_kind).toBe('agent');
    expect(row.actor_ref).toBe('tencent_ocr');
    expect(row.outcome).toBe('success');

    // parseEvent must accept the written shape (Lane B contract)
    expect(() =>
      parseEvent({
        actor_kind: row.actor_kind,
        actor_ref: row.actor_ref,
        action: row.action,
        subject_kind: row.subject_kind,
        subject_id: row.subject_id,
        outcome: row.outcome,
        payload: row.payload,
      }),
    ).not.toThrow();
  });

  it('writes outcome=failure with empty structured_block_ids + warnings carrying error message', async () => {
    const sessionId = await seedIngestionSession();
    const sourceDocId = createId();

    const eventId = await writeSessionEvent(db, {
      session_id: sessionId,
      action: 'extract',
      subject_kind: 'source_document',
      subject_id: sourceDocId,
      actor_kind: 'agent',
      actor_ref: 'tencent_ocr',
      outcome: 'failure',
      payload: {
        structured_block_ids: [],
        layout_quality: 'text_only',
        warnings: ['Tencent API timeout'],
      },
    });

    const rows = await db.select().from(event).where(eq(event.id, eventId));
    expect(rows[0].outcome).toBe('failure');
    expect((rows[0].payload as { warnings: string[] }).warnings).toEqual(['Tencent API timeout']);
  });

  it('passes optional fields (caused_by_event_id, task_run_id, cost_micro_usd) through', async () => {
    const sessionId = await seedIngestionSession();

    const parentId = await writeSessionEvent(db, {
      session_id: sessionId,
      action: 'extract',
      subject_kind: 'source_document',
      subject_id: createId(),
      actor_kind: 'agent',
      actor_ref: 'tencent_ocr',
      outcome: 'partial',
      payload: { structured_block_ids: ['b1'], layout_quality: 'partial', warnings: ['w1'] },
    });

    const childId = await writeSessionEvent(db, {
      session_id: sessionId,
      action: 'extract',
      subject_kind: 'source_document',
      subject_id: createId(),
      actor_kind: 'agent',
      actor_ref: 'vision_rescue',
      outcome: 'success',
      payload: { structured_block_ids: ['b2'], layout_quality: 'partial', warnings: [] },
      caused_by_event_id: parentId,
      task_run_id: 'tr_abc',
      cost_micro_usd: 1234,
    });

    const rows = await db.select().from(event).where(eq(event.id, childId));
    expect(rows[0].caused_by_event_id).toBe(parentId);
    expect(rows[0].task_run_id).toBe('tr_abc');
    expect(rows[0].cost_micro_usd).toBe(1234);
  });

  it('rejects shape that does not match ExtractSourceDocument (via parseEvent guard inside writeEvent)', async () => {
    const sessionId = await seedIngestionSession();
    await expect(
      writeSessionEvent(db, {
        session_id: sessionId,
        action: 'extract',
        subject_kind: 'source_document',
        subject_id: createId(),
        actor_kind: 'agent',
        actor_ref: 'tencent_ocr',
        outcome: 'success',
        payload: {
          // missing structured_block_ids / layout_quality
          warnings: [],
        } as never,
      }),
    ).rejects.toThrow();
  });
});
