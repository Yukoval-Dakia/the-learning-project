import { event } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { getProposalInboxRow, listLegacyKnowledgeProposals, listProposalInboxRows } from './inbox';
import { writeAiProposal } from './writer';

describe('proposal inbox reader', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('projects unified pending rows from ai_proposal payloads', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'node_p1',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'New node evidence',
        evidence_refs: [{ kind: 'event', id: 'attempt_1' }],
        proposed_change: {
          mutation: 'propose_new',
          name: '通假字',
          parent_id: 'parent_1',
        },
      },
    });
    await writeAiProposal(db, {
      id: 'edge_p1',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'Edge evidence',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'prerequisite',
          weight: 0.7,
        },
      },
    });

    const rows = await listProposalInboxRows(db);
    expect(rows.map((row) => row.id).sort()).toEqual(['edge_p1', 'node_p1']);
    expect(rows.every((row) => row.status === 'pending')).toBe(true);
    expect(rows.find((row) => row.id === 'node_p1')?.payload.kind).toBe('knowledge_node');
    expect(rows.find((row) => row.id === 'edge_p1')?.payload.kind).toBe('knowledge_edge');
  });

  it('uses the latest chained rate event for status', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'node_p1',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'New node evidence',
        evidence_refs: [],
        proposed_change: {
          mutation: 'propose_new',
          name: '通假字',
          parent_id: 'parent_1',
        },
      },
    });
    await db.insert(event).values({
      id: 'rate_old',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'node_p1',
      outcome: 'success',
      payload: { rating: 'dismiss' },
      caused_by_event_id: 'node_p1',
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date('2026-05-23T00:00:00.000Z'),
    });
    await db.insert(event).values({
      id: 'rate_new',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'node_p1',
      outcome: 'success',
      payload: { rating: 'accept' },
      caused_by_event_id: 'node_p1',
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date('2026-05-23T01:00:00.000Z'),
    });

    const rows = await listProposalInboxRows(db, { status: 'accepted' });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('node_p1');
    expect(rows[0].status).toBe('accepted');
    expect(rows[0].decided_at?.toISOString()).toBe('2026-05-23T01:00:00.000Z');
  });

  it('derives legacy proposal events without ai_proposal', async () => {
    const db = testDb();
    await db.insert(event).values({
      id: 'legacy_node',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'propose',
      subject_kind: 'knowledge',
      subject_id: 'synthetic_node',
      outcome: 'partial',
      payload: {
        name: '古今异义',
        parent_id: 'parent_1',
        reasoning: 'Legacy node event',
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    const rows = await listProposalInboxRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.kind).toBe('knowledge_node');
    expect(rows[0].payload.proposed_change).toMatchObject({
      mutation: 'propose_new',
      name: '古今异义',
      parent_id: 'parent_1',
    });
  });

  it('preserves the legacy knowledge proposal API projection', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'node_p1',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'New node evidence',
        evidence_refs: [],
        proposed_change: {
          mutation: 'propose_new',
          name: '通假字',
          parent_id: 'parent_1',
        },
      },
    });

    const rows = await listLegacyKnowledgeProposals(db, { status: 'pending' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'node_p1',
      kind: 'knowledge',
      payload: { mutation: 'propose_new', name: '通假字', parent_id: 'parent_1' },
      reasoning: 'New node evidence',
      status: 'pending',
      decided_at: null,
    });

    const raw = await db.select().from(event).where(eq(event.id, 'node_p1'));
    expect((raw[0].payload as Record<string, unknown>).ai_proposal).toBeTruthy();
  });

  it('returns one proposal by id through the shared reader', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'node_p1',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'New node evidence',
        evidence_refs: [],
        proposed_change: {
          mutation: 'propose_new',
          name: '通假字',
          parent_id: 'parent_1',
        },
      },
    });

    const row = await getProposalInboxRow(db, 'node_p1');
    expect(row?.id).toBe('node_p1');
    expect(row?.kind).toBe('knowledge_node');
    expect(row?.status).toBe('pending');
  });

  it('treats corrected proposal events as stale so they leave the pending queue', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'node_p1',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'New node evidence',
        evidence_refs: [],
        proposed_change: {
          mutation: 'propose_new',
          name: '通假字',
          parent_id: 'parent_1',
        },
      },
    });
    await writeEvent(db, {
      id: 'correct_node_p1',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'node_p1',
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'bad proposal',
        affected_refs: [{ kind: 'open_inquiry', id: 'node_p1' }],
      },
      caused_by_event_id: 'node_p1',
      created_at: new Date('2026-05-23T02:00:00.000Z'),
    });

    await expect(listProposalInboxRows(db, { status: 'pending' })).resolves.toEqual([]);
    const stale = await listProposalInboxRows(db, { status: 'stale' });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      id: 'node_p1',
      status: 'stale',
    });
    expect(stale[0].decided_at?.toISOString()).toBe('2026-05-23T02:00:00.000Z');
  });
});
