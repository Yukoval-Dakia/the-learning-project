import { event, proposal_signals } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  getProposalInboxRow,
  listLegacyKnowledgeProposals,
  listProposalInboxPage,
  listProposalInboxRows,
} from './inbox';
import { recordProposalDecisionSignal } from './signals';
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

  it('normalizes bare experimental knowledge propose events into unified inbox rows', async () => {
    const db = testDb();
    await db.insert(event).values({
      id: 'legacy_experimental_node',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'experimental:knowledge_propose',
      subject_kind: 'knowledge',
      subject_id: 'synthetic_node',
      outcome: 'partial',
      payload: {
        name: '判断句',
        parent_id: 'parent_1',
        reasoning: 'Older writer used the experimental namespace',
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    const rows = await listProposalInboxRows(db);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'legacy_experimental_node',
      kind: 'knowledge_node',
      payload: {
        kind: 'knowledge_node',
        proposed_change: {
          mutation: 'propose_new',
          name: '判断句',
          parent_id: 'parent_1',
        },
      },
      source_action: 'experimental:knowledge_propose',
    });
  });

  it('projects legacy reparent/merge/split knowledge mutations as knowledge_mutation, not archive', async () => {
    const db = testDb();
    await db.insert(event).values({
      id: 'legacy_reparent',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'maintenance',
      action: 'experimental:knowledge_reparent',
      subject_kind: 'knowledge',
      subject_id: 'k_child',
      outcome: 'partial',
      payload: {
        node_id: 'k_child',
        new_parent_id: 'k_parent',
        expected_version: 0,
        reasoning: 'Move this node under the more precise parent.',
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    const row = await getProposalInboxRow(db, 'legacy_reparent');

    expect(row).toMatchObject({
      id: 'legacy_reparent',
      kind: 'knowledge_mutation',
      payload: {
        kind: 'knowledge_mutation',
        proposed_change: {
          mutation: 'reparent',
          node_id: 'k_child',
          new_parent_id: 'k_parent',
          expected_version: 0,
        },
      },
      source_action: 'experimental:knowledge_reparent',
    });
  });

  it('skips and logs invalid proposal payloads without failing the whole inbox', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = testDb();
    await writeAiProposal(db, {
      id: 'valid_p1',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_ok' },
        reason_md: 'valid row',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_ok' },
      },
    });
    await db.insert(event).values({
      id: 'bad_p1',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'bad_writer',
      action: 'experimental:proposal',
      subject_kind: 'learning_item',
      subject_id: 'li_bad',
      outcome: 'partial',
      payload: { ai_proposal: { kind: 'completion' } },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(Date.now() + 1_000),
    });

    const rows = await listProposalInboxRows(db);

    expect(rows.map((row) => row.id)).toEqual(['valid_p1']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipping invalid proposal event bad_p1'),
      expect.anything(),
    );
    warn.mockRestore();
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

  it('ranks active high-acceptance proposals before default rows and cooled rows', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'default_p1',
      created_at: new Date('2026-05-23T03:00:00.000Z'),
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_default' },
        reason_md: 'Default row',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_default' },
        cooldown_key: 'completion:default',
      },
    });
    await writeAiProposal(db, {
      id: 'cooled_p1',
      created_at: new Date('2026-05-23T04:00:00.000Z'),
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_cooled' },
        reason_md: 'Cooled row',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_cooled' },
        cooldown_key: 'completion:cooled',
      },
    });
    await writeAiProposal(db, {
      id: 'high_p1',
      created_at: new Date('2026-05-23T01:00:00.000Z'),
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_high' },
        reason_md: 'High rate row',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_high' },
        cooldown_key: 'completion:high',
      },
    });

    const beforeSignals = await listProposalInboxRows(db, { status: 'pending' });
    const high = beforeSignals.find((row) => row.id === 'high_p1');
    const cooled = beforeSignals.find((row) => row.id === 'cooled_p1');
    if (!high || !cooled) throw new Error('missing seeded proposals');
    await recordProposalDecisionSignal(db, high, 'accept');
    await recordProposalDecisionSignal(db, cooled, 'dismiss', 'not now');

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows.map((row) => row.id)).toEqual(['high_p1', 'default_p1', 'cooled_p1']);
    expect(rows[0].signals?.acceptance_rate).toBe(1);
    expect(rows[2].signals?.cooldown_until).toBeInstanceOf(Date);
  });

  it('paginates using the same signal-aware order as the inbox ranking', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'default_p1',
      created_at: new Date('2026-05-23T03:00:00.000Z'),
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_default' },
        reason_md: 'Default row',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_default' },
        cooldown_key: 'completion:default',
      },
    });
    await writeAiProposal(db, {
      id: 'high_p1',
      created_at: new Date('2026-05-23T01:00:00.000Z'),
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_high' },
        reason_md: 'Older row with better historical signal',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_high' },
        cooldown_key: 'completion:high',
      },
    });
    await writeAiProposal(db, {
      id: 'cooled_p1',
      created_at: new Date('2026-05-23T04:00:00.000Z'),
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_cooled' },
        reason_md: 'Newest but cooled row',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_cooled' },
        cooldown_key: 'completion:cooled',
      },
    });

    const allRows = await listProposalInboxRows(db, { status: 'pending' });
    const high = allRows.find((row) => row.id === 'high_p1');
    const cooled = allRows.find((row) => row.id === 'cooled_p1');
    if (!high || !cooled) throw new Error('missing seeded proposals');
    await recordProposalDecisionSignal(db, high, 'accept');
    await recordProposalDecisionSignal(db, cooled, 'dismiss', 'not now');

    const first = await listProposalInboxPage(db, { status: 'pending', limit: 1 });
    expect(first.rows.map((row) => row.id)).toEqual(['high_p1']);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await listProposalInboxPage(db, {
      status: 'pending',
      limit: 1,
      cursor: first.next_cursor ?? undefined,
    });
    expect(second.rows.map((row) => row.id)).toEqual(['default_p1']);
    expect(second.next_cursor).toEqual(expect.any(String));

    const third = await listProposalInboxPage(db, {
      status: 'pending',
      limit: 1,
      cursor: second.next_cursor ?? undefined,
    });
    expect(third.rows.map((row) => row.id)).toEqual(['cooled_p1']);
    expect(third.next_cursor).toBeNull();
  });

  it('keeps cooldown ranking time stable across sparse multi-batch pagination', async () => {
    const db = testDb();
    const baseTime = new Date('2026-05-23T00:00:00.000Z');

    for (let i = 0; i < 50; i++) {
      await writeAiProposal(db, {
        id: `pending_p${i}`,
        created_at: new Date(baseTime.getTime() + (100 + i) * 1_000),
        payload: {
          kind: 'completion',
          target: { subject_kind: 'learning_item', subject_id: `li_pending_${i}` },
          reason_md: 'Pending row ahead of accepted sparse match',
          evidence_refs: [],
          proposed_change: { learning_item_id: `li_pending_${i}` },
          cooldown_key: `completion:pending:${i}`,
        },
      });
    }
    await writeAiProposal(db, {
      id: 'accepted_cooled',
      created_at: new Date(baseTime.getTime() + 1_000),
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_accepted' },
        reason_md: 'Accepted row initially sorted after non-cooled rows',
        evidence_refs: [],
        proposed_change: { learning_item_id: 'li_accepted' },
        cooldown_key: 'completion:accepted',
      },
    });
    await db.insert(event).values({
      id: 'rate_accepted_cooled',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'accepted_cooled',
      outcome: 'success',
      payload: { rating: 'accept' },
      caused_by_event_id: 'accepted_cooled',
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(baseTime.getTime() + 2_000),
    });
    await db.insert(proposal_signals).values({
      id: 'signal_accepted_cooled',
      kind: 'completion',
      cooldown_key: 'completion:accepted',
      accept_count: 1,
      dismiss_count: 0,
      acceptance_rate: 1,
      dismiss_reason: null,
      cooldown_until: new Date('2026-05-23T00:00:01.000Z'),
      created_at: baseTime,
      updated_at: baseTime,
    });

    const realDate = Date;
    let callCount = 0;
    class StepDate extends realDate {
      constructor(...args: [] | [string | number | Date]) {
        if (args.length === 0) {
          const instant =
            callCount++ === 0 ? '2026-05-23T00:00:00.500Z' : '2026-05-23T00:00:02.000Z';
          super(instant);
        } else {
          super(args[0]);
        }
      }

      static now() {
        return new StepDate().getTime();
      }
    }

    vi.stubGlobal('Date', StepDate);
    try {
      const page = await listProposalInboxPage(db, { status: 'accepted', limit: 1 });
      expect(page.rows.map((row) => row.id)).toEqual(['accepted_cooled']);
      expect(page.next_cursor).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // YUK-19 — planLearningIntent writes proposals with the legacy
  // `experimental:propose_learning_intent` action. They must surface in the
  // unified inbox so the rollback / accept UI can find them.
  it('surfaces experimental:propose_learning_intent rows as kind=learning_item', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'intent_p1',
      payload: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        reason_md: '学习路径提议：虚词',
        evidence_refs: [],
        proposed_change: {
          topic: '虚词',
          knowledge_node: { id: 'k_hub', name: '虚词', domain: 'wenyan' },
          hub: { title: '虚词总览', summary_md: '...' },
          atomics: [{ knowledge_id: 'k_zhi', title: '之', one_line_intent: '...' }],
        },
      },
      event_override: {
        action: 'experimental:propose_learning_intent',
        subject_kind: 'artifact',
        subject_id: 'art_synthetic',
        payload: { topic: '虚词' },
      },
    });

    const rows = await listProposalInboxRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'intent_p1',
      kind: 'learning_item',
      status: 'pending',
      source_action: 'experimental:propose_learning_intent',
    });
  });
});
