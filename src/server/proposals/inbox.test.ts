import { event, proposal_signals } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  countPendingProposalInboxByKind,
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

  it('pushes the legacy knowledge archive fallback into the observation lane', async () => {
    const db = testDb();
    await db.insert(event).values({
      id: 'legacy_archive_observation',
      actor_kind: 'agent',
      actor_ref: 'maintenance',
      action: 'experimental:knowledge_archive',
      subject_kind: 'knowledge',
      subject_id: 'k_stale',
      outcome: 'partial',
      payload: { node_id: 'k_stale', reasoning: 'No longer supported by evidence.' },
      created_at: new Date(),
    });

    await expect(
      listProposalInboxRows(db, { lane: 'decision', status: 'pending' }),
    ).resolves.toEqual([]);
    const observations = await listProposalInboxRows(db, {
      lane: 'observation',
      status: 'pending',
    });
    expect(observations.map((row) => [row.id, row.kind])).toEqual([
      ['legacy_archive_observation', 'archive'],
    ]);
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
          knowledge_node: { id: 'k_hub', name: '虚词', domain: 'yuwen' },
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

  // P5.4 / YUK-143 (RB-7 leg (a)) — a propose event carrying a `rubric_verdict`
  // marker (ok:false) must derive the TERMINAL 'rubric_rejected' status via
  // deriveProposalStatus/isRubricRejected, NOT 'pending'. This pins the inbox
  // derive directly (the dup-pending callers in proposal-tools / review key on
  // status:'pending', so a wrong derivation here would silently re-introduce
  // the lockout). A folded event has NO chained rate → would otherwise be
  // 'pending' under the event-derived model.
  it('derives terminal rubric_rejected status for a folded (rubric_verdict) propose event', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'edge_folded',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'evidence-free agent edge → rubric rejected',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'related_to',
          weight: 1,
        },
      },
      event_override: {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        payload: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'related_to',
          weight: 1,
          reasoning: 'evidence-free agent edge → rubric rejected',
          rubric_verdict: { ok: false, gate: 'evidence_missing', reason: 'no evidence' },
        },
      },
    });

    // Single-row projection → terminal rubric_rejected, not pending.
    const row = await getProposalInboxRow(db, 'edge_folded');
    expect(row?.status).toBe('rubric_rejected');

    // The folded row is excluded from the pending bucket (RB-7) and surfaces in
    // the rubric_rejected bucket (RB-8) instead.
    const pending = await listProposalInboxRows(db, { status: 'pending' });
    expect(pending.find((r) => r.id === 'edge_folded')).toBeUndefined();
    const folded = await listProposalInboxRows(db, { status: 'rubric_rejected' });
    expect(folded.map((r) => r.id)).toContain('edge_folded');
  });

  // ADR-0034 §2 / YUK-344 (RB-7 twin for the TOPOLOGY marker) — a propose event
  // the write-time topology gate hard-rejected carries a `topology_verdict.status
  // = 'reject'` marker (sibling of ai_proposal) and NO rubric_verdict key. It must
  // derive the TERMINAL 'rubric_rejected' (folded / non-pending / non-acceptable)
  // status via deriveProposalStatus/isTopologyRejected, NOT 'pending'. Without
  // this the topology fold (which has no chained rate) would derive 'pending' and
  // re-occupy the (kind, cooldown_key) for the dup-pending callers — the same
  // lockout RB-7 forbids, now via the topology marker.
  it('derives terminal status for a topology-rejected (topology_verdict) propose event, not pending', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'edge_topo_folded',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'cycle-closing agent edge → topology rejected',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'prerequisite',
          weight: 1,
        },
      },
      event_override: {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        payload: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'prerequisite',
          weight: 1,
          reasoning: 'cycle-closing agent edge → topology rejected',
          topology_verdict: { status: 'reject', gate: 'cycle', reason: 'closes a cycle' },
        },
      },
    });

    // Single-row projection → terminal (non-pending, non-acceptable), folded into
    // the rubric_rejected bucket. NOT pending.
    const row = await getProposalInboxRow(db, 'edge_topo_folded');
    expect(row?.status).toBe('rubric_rejected');
    expect(row?.status).not.toBe('pending');
    expect(row?.status).not.toBe('accepted');

    // Excluded from the live-pending bucket (the RB-7 twin invariant) and surfaces
    // in the folded bucket instead.
    const pending = await listProposalInboxRows(db, { status: 'pending' });
    expect(pending.find((r) => r.id === 'edge_topo_folded')).toBeUndefined();
    const folded = await listProposalInboxRows(db, { status: 'rubric_rejected' });
    expect(folded.map((r) => r.id)).toContain('edge_topo_folded');
  });

  // P5.4 / YUK-143 (codex r4 P2 #2) — correction status takes PRIORITY over the
  // rubric_rejected marker. A folded edge that is later retracted/corrected must
  // clear the folded bucket and derive 'stale', otherwise it stays pinned as
  // rubric_rejected forever and can never be cleared from ?status=rubric_rejected.
  it('clears a folded (rubric_rejected) proposal to stale once it is corrected/retracted', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'edge_folded_corrected',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'evidence-free agent edge → rubric rejected',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'related_to',
          weight: 1,
        },
      },
      event_override: {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        payload: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'related_to',
          weight: 1,
          reasoning: 'evidence-free agent edge → rubric rejected',
          rubric_verdict: { ok: false, gate: 'evidence_missing', reason: 'no evidence' },
        },
      },
    });
    await writeEvent(db, {
      id: 'correct_edge_folded',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'edge_folded_corrected',
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'retract folded edge',
        affected_refs: [{ kind: 'open_inquiry', id: 'edge_folded_corrected' }],
      },
      caused_by_event_id: 'edge_folded_corrected',
      created_at: new Date('2026-05-23T05:00:00.000Z'),
    });

    // Single-row projection now derives stale (correction wins over the marker).
    const row = await getProposalInboxRow(db, 'edge_folded_corrected');
    expect(row?.status).toBe('stale');

    // It has dropped out of the folded rubric_rejected bucket…
    const folded = await listProposalInboxRows(db, { status: 'rubric_rejected' });
    expect(folded.find((r) => r.id === 'edge_folded_corrected')).toBeUndefined();
    // …and now surfaces in the stale bucket instead.
    const stale = await listProposalInboxRows(db, { status: 'stale' });
    expect(stale.map((r) => r.id)).toContain('edge_folded_corrected');
    // …and is still excluded from the live-pending bucket (RB-7 intact: stale is
    // non-pending just like rubric_rejected was).
    const pending = await listProposalInboxRows(db, { status: 'pending' });
    expect(pending.find((r) => r.id === 'edge_folded_corrected')).toBeUndefined();
  });

  it('aggregates exact pending counts without materializing ranked inbox pages', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'count_defer',
      payload: {
        kind: 'defer',
        target: { subject_kind: 'learning_item', subject_id: 'item_count' },
        reason_md: 'observe only',
        evidence_refs: [],
        proposed_change: {
          learning_item_id: 'item_count',
          defer_until: '2026-07-18T00:00:00.000Z',
          reason: 'low energy',
        },
      },
    });
    for (const id of ['count_pending', 'count_accepted'] as const) {
      await writeAiProposal(db, {
        id,
        payload: {
          kind: 'knowledge_edge',
          target: { subject_kind: 'knowledge_edge', subject_id: null },
          reason_md: id,
          evidence_refs: [],
          proposed_change: {
            from_knowledge_id: `${id}_from`,
            to_knowledge_id: `${id}_to`,
            relation_type: 'related_to',
            weight: 1,
          },
        },
      });
    }
    await db.insert(event).values({
      id: 'count_rate',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'count_accepted',
      outcome: 'success',
      payload: { rating: 'accept' },
      caused_by_event_id: 'count_accepted',
      created_at: new Date('2026-07-17T00:00:00.000Z'),
    });
    await db.insert(event).values({
      id: 'count_invalid',
      actor_kind: 'agent',
      actor_ref: 'bad_writer',
      action: 'experimental:proposal',
      subject_kind: 'learning_item',
      subject_id: 'invalid_item',
      outcome: 'partial',
      payload: { ai_proposal: { kind: 'completion' } },
      created_at: new Date('2026-07-17T00:00:30.000Z'),
    });
    await db.insert(event).values({
      id: 'count_invalid_empty_change',
      actor_kind: 'agent',
      actor_ref: 'bad_writer',
      action: 'experimental:proposal',
      subject_kind: 'learning_item',
      subject_id: 'invalid_empty_change',
      outcome: 'partial',
      payload: {
        ai_proposal: {
          kind: 'completion',
          target: { subject_kind: 'learning_item', subject_id: 'invalid_empty_change' },
          reason_md: 'Looks complete at the base level but violates the kind schema.',
          evidence_refs: [],
          proposed_change: {},
        },
      },
      created_at: new Date('2026-07-17T00:00:40.000Z'),
    });
    await db.insert(event).values({
      id: 'count_invalid_target_kind',
      actor_kind: 'agent',
      actor_ref: 'bad_writer',
      action: 'experimental:proposal',
      subject_kind: 'learning_item',
      subject_id: 'invalid_target_kind',
      outcome: 'partial',
      payload: {
        kind: 'defer',
        target: { subject_kind: 'question', subject_id: 'invalid_target_kind' },
        reason_md: 'The kind-specific target does not match the proposal schema.',
        proposed_change: { defer_until: '2026-07-18T00:00:00.000Z' },
      },
      created_at: new Date('2026-07-17T00:00:41.000Z'),
    });
    await db.insert(event).values({
      id: 'count_invalid_evidence_ref',
      actor_kind: 'agent',
      actor_ref: 'bad_writer',
      action: 'experimental:proposal',
      subject_kind: 'learning_item',
      subject_id: 'invalid_evidence_ref',
      outcome: 'partial',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'invalid_evidence_ref' },
        reason_md: 'The evidence item lacks its required kind discriminator.',
        evidence_refs: [{ id: 'event_without_kind' }],
        proposed_change: { learning_item_id: 'invalid_evidence_ref' },
      },
      created_at: new Date('2026-07-17T00:00:42.000Z'),
    });
    await db.insert(event).values({
      id: 'count_invalid_question_edit',
      actor_kind: 'agent',
      actor_ref: 'bad_writer',
      action: 'experimental:proposal',
      subject_kind: 'question',
      subject_id: 'question_invalid_edit',
      outcome: 'partial',
      payload: {
        kind: 'question_edit',
        target: { subject_kind: 'question', subject_id: 'question_invalid_edit' },
        reason_md: 'The operation discriminator is valid but its required fields are absent.',
        evidence_refs: [],
        proposed_change: {
          question_id: 'question_invalid_edit',
          edit: { op: 'set_choice' },
        },
      },
      created_at: new Date('2026-07-17T00:00:42.500Z'),
    });
    await writeAiProposal(db, {
      id: 'count_valid_reparent',
      payload: {
        kind: 'knowledge_mutation',
        target: { subject_kind: 'knowledge', subject_id: 'node_a' },
        reason_md: 'Move the node under its corrected parent.',
        evidence_refs: [],
        proposed_change: {
          mutation: 'reparent',
          node_id: 'node_a',
          new_parent_id: null,
          expected_version: 1,
        },
      },
    });
    await writeAiProposal(db, {
      id: 'count_valid_merge',
      payload: {
        kind: 'knowledge_mutation',
        target: { subject_kind: 'knowledge', subject_id: 'node_b' },
        reason_md: 'Merge duplicate nodes into the canonical node.',
        evidence_refs: [],
        proposed_change: {
          mutation: 'merge',
          from_ids: ['node_b'],
          into_id: 'node_a',
          expected_versions: { node_a: 2, node_b: 1 },
        },
      },
    });
    await writeAiProposal(db, {
      id: 'count_valid_split',
      payload: {
        kind: 'knowledge_mutation',
        target: { subject_kind: 'knowledge', subject_id: 'node_c' },
        reason_md: 'Split the overloaded concept into two focused nodes.',
        evidence_refs: [],
        proposed_change: {
          mutation: 'split',
          from_id: 'node_c',
          into: [
            { name: 'Child A', parent_id: null },
            { name: 'Child B', parent_id: 'node_a' },
          ],
          expected_version: 3,
        },
      },
    });
    for (const [id, proposedChange] of [
      ['count_invalid_reparent', { mutation: 'reparent' }],
      [
        'count_invalid_merge',
        {
          mutation: 'merge',
          from_ids: ['node_a'],
          into_id: 'node_b',
          expected_versions: { node_a: 1.5 },
        },
      ],
      [
        'count_invalid_split',
        {
          mutation: 'split',
          from_id: 'node_a',
          into: [{ name: 'child without required parent_id' }],
          expected_version: 1,
        },
      ],
    ] as const) {
      await db.insert(event).values({
        id,
        actor_kind: 'agent',
        actor_ref: 'bad_writer',
        action: 'experimental:proposal',
        subject_kind: 'knowledge',
        subject_id: 'node_a',
        outcome: 'partial',
        payload: {
          kind: 'knowledge_mutation',
          target: { subject_kind: 'knowledge', subject_id: 'node_a' },
          reason_md: 'The mutation discriminator is valid but its variant shape is not.',
          evidence_refs: [],
          proposed_change: proposedChange,
        },
        created_at: new Date('2026-07-17T00:00:43.000Z'),
      });
    }
    await db.insert(event).values({
      id: 'count_legacy_without_evidence_refs',
      actor_kind: 'agent',
      actor_ref: 'legacy_writer',
      action: 'experimental:proposal',
      subject_kind: 'learning_item',
      subject_id: 'legacy_item',
      outcome: 'partial',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'legacy_item' },
        reason_md: 'Legacy schema defaulted evidence_refs to an empty array.',
        proposed_change: { learning_item_id: 'legacy_item', completion_evidence: 'done' },
      },
      created_at: new Date('2026-07-17T00:00:45.000Z'),
    });
    await writeAiProposal(db, {
      id: 'count_folded',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'folded',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'folded_from',
          to_knowledge_id: 'folded_to',
          relation_type: 'related_to',
          weight: 1,
        },
      },
      event_override: {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        payload: {
          from_knowledge_id: 'folded_from',
          to_knowledge_id: 'folded_to',
          relation_type: 'related_to',
          weight: 1,
          reasoning: 'folded',
          rubric_verdict: { ok: false, gate: 'evidence_missing', reason: 'no evidence' },
        },
      },
    });

    await writeEvent(db, {
      id: 'count_retract',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'count_pending',
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'temporary retract',
        affected_refs: [{ kind: 'open_inquiry', id: 'count_pending' }],
      },
      caused_by_event_id: 'count_pending',
      created_at: new Date('2026-07-17T00:01:00.000Z'),
    });
    await writeEvent(db, {
      id: 'count_restore',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'count_pending',
      outcome: 'success',
      payload: {
        correction_kind: 'restore',
        reason_md: 'restore pending proposal',
        affected_refs: [{ kind: 'open_inquiry', id: 'count_pending' }],
      },
      caused_by_event_id: 'count_retract',
      created_at: new Date('2026-07-17T00:02:00.000Z'),
    });
    // A correction-shaped row is not a correction unless it passes CorrectEvent.
    // The Inbox skips this missing reason/affected_refs payload, so the KPI must too.
    await db.insert(event).values({
      id: 'count_malformed_correction',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'count_defer',
      outcome: 'success',
      payload: { correction_kind: 'retract' },
      caused_by_event_id: 'count_defer',
      created_at: new Date('2026-07-17T00:03:00.000Z'),
    });

    const result = await countPendingProposalInboxByKind(db);
    const counts = result.byKind;
    const projectedCounts = (await listProposalInboxRows(db, { status: 'pending' })).reduce<
      Record<string, number>
    >((acc, row) => {
      acc[row.kind] = (acc[row.kind] ?? 0) + 1;
      return acc;
    }, {});

    expect(counts).toEqual({
      completion: 1,
      defer: 1,
      knowledge_edge: 1,
      knowledge_mutation: 3,
    });
    expect(counts).toEqual(projectedCounts);
    expect(result.hasMore).toBe(false);
  });

  it('filters the ranked pending page by actor_ref and honors limit without dropping lower-ranked matches', async () => {
    const db = testDb();
    // Interleave dreaming- and self-authored pending proposals so the top-ranked
    // rows are NOT all dreaming. Ranking with no signals is desc(created_at),
    // desc(id), so full order is d1, s1, d2, s2, d3.
    const deferRow = (
      id: string,
      actorRef: string,
      createdAt: string,
    ): typeof event.$inferInsert => ({
      id,
      actor_kind: 'agent',
      actor_ref: actorRef,
      action: 'experimental:proposal',
      subject_kind: 'learning_item',
      subject_id: `item_${id}`,
      outcome: 'partial',
      payload: {
        ai_proposal: {
          kind: 'defer',
          target: { subject_kind: 'learning_item', subject_id: `item_${id}` },
          reason_md: `observe ${id}`,
          evidence_refs: [],
          proposed_change: {
            learning_item_id: `item_${id}`,
            defer_until: '2026-07-18T00:00:00.000Z',
            reason: 'low energy',
          },
        },
      },
      created_at: new Date(createdAt),
    });
    await db
      .insert(event)
      .values([
        deferRow('d1', 'dreaming', '2026-07-17T00:05:00.000Z'),
        deferRow('s1', 'self', '2026-07-17T00:04:00.000Z'),
        deferRow('d2', 'dreaming', '2026-07-17T00:03:00.000Z'),
        deferRow('s2', 'self', '2026-07-17T00:02:00.000Z'),
        deferRow('d3', 'dreaming', '2026-07-17T00:01:00.000Z'),
      ]);

    const allPending = await listProposalInboxPage(db, { status: 'pending' });
    const dreamingFromFull = allPending.rows
      .filter((row) => row.actor_ref === 'dreaming')
      .map((row) => row.id);
    expect(dreamingFromFull).toEqual(['d1', 'd2', 'd3']);

    // actorRef filter returns exactly the dreaming rows, in the same ranking order.
    const dreamingOnly = await listProposalInboxPage(db, {
      status: 'pending',
      actorRef: 'dreaming',
    });
    expect(dreamingOnly.rows.map((row) => row.id)).toEqual(['d1', 'd2', 'd3']);

    // Bounded fetch: the limit caps dreaming matches, and d2 (ranked below the
    // higher self row s1) is NOT lost — this is exactly what the /today drawer
    // preview relies on when it stops after `previewLimit` dreaming rows.
    const boundedDreaming = await listProposalInboxPage(db, {
      status: 'pending',
      actorRef: 'dreaming',
      limit: 2,
    });
    expect(boundedDreaming.rows.map((row) => row.id)).toEqual(['d1', 'd2']);
    expect(boundedDreaming.rows.map((row) => row.id)).toEqual(dreamingFromFull.slice(0, 2));
  });

  it('counts in bounded batches and keeps decisions reachable behind an observation backlog', async () => {
    const db = testDb();
    const observationRows: Array<typeof event.$inferInsert> = Array.from(
      { length: 501 },
      (_, index) => ({
        id: `batched_defer_${String(index).padStart(3, '0')}`,
        actor_kind: 'agent',
        actor_ref: 'dreaming',
        action: 'experimental:proposal',
        subject_kind: 'learning_item',
        subject_id: `item_${index}`,
        outcome: 'partial',
        payload: {
          ai_proposal: {
            kind: 'defer',
            target: { subject_kind: 'learning_item', subject_id: `item_${index}` },
            reason_md: 'observe only',
            evidence_refs: [],
            proposed_change: {
              learning_item_id: `item_${index}`,
              defer_until: '2026-07-18T00:00:00.000Z',
              reason: 'low energy',
            },
          },
        },
        created_at: new Date('2026-07-17T01:00:00.000Z'),
      }),
    );
    await db.insert(event).values(observationRows);
    await writeAiProposal(db, {
      id: 'decision_after_observations',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'This decision must remain reachable.',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'decision_from',
          to_knowledge_id: 'decision_to',
          relation_type: 'related_to',
          weight: 1,
        },
      },
      created_at: new Date('2026-07-17T00:00:00.000Z'),
    });

    await expect(countPendingProposalInboxByKind(db)).resolves.toEqual({
      byKind: { defer: 501, knowledge_edge: 1 },
      hasMore: false,
    });

    const decisionPage = await listProposalInboxPage(db, {
      status: 'pending',
      lane: 'decision',
      limit: 1,
    });
    expect(decisionPage.rows.map((row) => row.id)).toEqual(['decision_after_observations']);
    expect(decisionPage.next_cursor).toBeNull();
  });

  it('returns a lower bound instead of failing Today at the candidate safety ceiling', async () => {
    const db = testDb();
    const rows: Array<typeof event.$inferInsert> = Array.from({ length: 501 }, (_, index) => ({
      id: `bounded_scan_${String(index).padStart(3, '0')}`,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'experimental:proposal',
      subject_kind: 'learning_item',
      subject_id: `bounded_item_${index}`,
      outcome: 'partial',
      payload: {
        ai_proposal: {
          kind: 'defer',
          target: { subject_kind: 'learning_item', subject_id: `bounded_item_${index}` },
          reason_md: 'bounded scan fixture',
          evidence_refs: [],
          proposed_change: {
            learning_item_id: `bounded_item_${index}`,
            defer_until: '2026-07-18T00:00:00.000Z',
            reason: 'low energy',
          },
        },
      },
      created_at: new Date(1_800_000_000_000 + index),
    }));
    await db.insert(event).values(rows);

    await expect(
      countPendingProposalInboxByKind(db, { batchSize: 500, maxBatches: 1 }),
    ).resolves.toEqual({
      byKind: { defer: 500 },
      hasMore: true,
    });
  });
});
