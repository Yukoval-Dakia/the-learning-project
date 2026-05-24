// YUK-15 — unit tests for record_processing helpers.

import { learning_record } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { writeAiProposal } from '../proposals/writer';
import {
  extractRecordEvidenceIds,
  getProposalCountsForRecords,
  markRecordsActioned,
  markRecordsLinked,
  rollbackRecordsActioned,
} from './record_processing';

async function seedRecord(id: string, status: 'raw' | 'linked' | 'actioned' | 'archived' = 'raw') {
  const now = new Date();
  await testDb()
    .insert(learning_record)
    .values({
      id,
      kind: 'open_question',
      title: null,
      content_md: 'why?',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'ask',
      processing_status: status,
      origin_event_id: null,
      subject_id: null,
      knowledge_ids: [],
      question_id: null,
      attempt_event_id: null,
      learning_item_id: null,
      artifact_id: null,
      source_document_id: null,
      asset_refs: [],
      payload: {},
      created_at: now,
      updated_at: now,
      archived_at: status === 'archived' ? now : null,
      version: 0,
    });
}

async function getStatus(id: string): Promise<string | null> {
  const rows = await testDb()
    .select({ status: learning_record.processing_status })
    .from(learning_record)
    .where(eq(learning_record.id, id));
  return rows[0]?.status ?? null;
}

describe('extractRecordEvidenceIds', () => {
  it('returns unique record ids from mixed-kind evidence_refs', () => {
    expect(
      extractRecordEvidenceIds([
        { kind: 'event', id: 'e1' },
        { kind: 'record', id: 'r1' },
        { kind: 'record', id: 'r1' }, // dup
        { kind: 'record', id: 'r2' },
        { kind: 'knowledge', id: 'k1' },
      ]),
    ).toEqual(['r1', 'r2']);
  });

  it('returns [] for empty / non-record refs', () => {
    expect(extractRecordEvidenceIds([])).toEqual([]);
    expect(
      extractRecordEvidenceIds([
        { kind: 'event', id: 'e1' },
        { kind: 'question', id: 'q1' },
      ]),
    ).toEqual([]);
  });
});

describe('markRecordsLinked / markRecordsActioned / rollbackRecordsActioned', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('flips raw → linked, leaves linked/actioned/archived alone', async () => {
    await seedRecord('r-raw', 'raw');
    await seedRecord('r-linked', 'linked');
    await seedRecord('r-actioned', 'actioned');
    await seedRecord('r-archived', 'archived');

    const flipped = await markRecordsLinked(testDb(), [
      'r-raw',
      'r-linked',
      'r-actioned',
      'r-archived',
    ]);
    expect(flipped).toBe(1);

    expect(await getStatus('r-raw')).toBe('linked');
    expect(await getStatus('r-linked')).toBe('linked');
    expect(await getStatus('r-actioned')).toBe('actioned');
    expect(await getStatus('r-archived')).toBe('archived');
  });

  it('no-op on empty input', async () => {
    expect(await markRecordsLinked(testDb(), [])).toBe(0);
    expect(await markRecordsActioned(testDb(), [])).toBe(0);
    expect(await rollbackRecordsActioned(testDb(), [])).toBe(0);
  });

  it('markRecordsActioned flips both raw and linked → actioned', async () => {
    await seedRecord('r-raw', 'raw');
    await seedRecord('r-linked', 'linked');
    await seedRecord('r-archived', 'archived');

    const flipped = await markRecordsActioned(testDb(), ['r-raw', 'r-linked', 'r-archived']);
    expect(flipped).toBe(2);

    expect(await getStatus('r-raw')).toBe('actioned');
    expect(await getStatus('r-linked')).toBe('actioned');
    expect(await getStatus('r-archived')).toBe('archived');
  });

  it('rollbackRecordsActioned reverts actioned → linked only', async () => {
    await seedRecord('r-actioned', 'actioned');
    await seedRecord('r-linked', 'linked');
    await seedRecord('r-raw', 'raw');

    const flipped = await rollbackRecordsActioned(testDb(), ['r-actioned', 'r-linked', 'r-raw']);
    expect(flipped).toBe(1);

    expect(await getStatus('r-actioned')).toBe('linked');
    expect(await getStatus('r-linked')).toBe('linked');
    expect(await getStatus('r-raw')).toBe('raw');
  });
});

describe('getProposalCountsForRecords', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 0 for records with no proposal evidence', async () => {
    await seedRecord('r1');
    const counts = await getProposalCountsForRecords(testDb(), ['r1']);
    expect(counts.get('r1')).toBe(0);
  });

  it('counts propose events whose ai_proposal.evidence_refs cite the record', async () => {
    await seedRecord('r1');
    await seedRecord('r2');

    // Two learning_item proposals citing r1, one citing r2, one citing both.
    await writeAiProposal(testDb(), {
      id: createId(),
      actor_ref: 'test',
      payload: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        reason_md: 'test',
        evidence_refs: [{ kind: 'record', id: 'r1' }],
        proposed_change: { topic: 'a' },
      },
      event_override: {
        action: 'experimental:propose_learning_intent',
        subject_kind: 'artifact',
        subject_id: createId(),
        payload: {},
      },
    });
    await writeAiProposal(testDb(), {
      id: createId(),
      actor_ref: 'test',
      payload: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        reason_md: 'test',
        evidence_refs: [
          { kind: 'record', id: 'r1' },
          { kind: 'record', id: 'r2' },
        ],
        proposed_change: { topic: 'b' },
      },
      event_override: {
        action: 'experimental:propose_learning_intent',
        subject_kind: 'artifact',
        subject_id: createId(),
        payload: {},
      },
    });
    await writeAiProposal(testDb(), {
      id: createId(),
      actor_ref: 'test',
      payload: {
        kind: 'note_update',
        target: { subject_kind: 'artifact', subject_id: createId() },
        reason_md: 'test',
        evidence_refs: [{ kind: 'record', id: 'r2' }],
        proposed_change: { artifact_id: 'a1', summary_md: 'x' },
      },
    });

    const counts = await getProposalCountsForRecords(testDb(), ['r1', 'r2']);
    expect(counts.get('r1')).toBe(2);
    expect(counts.get('r2')).toBe(2);
  });
});
