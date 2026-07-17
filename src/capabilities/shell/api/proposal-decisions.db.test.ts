import { event, knowledge } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET as getEventDetail } from '../../observability/api/event-detail';
import { POST } from './proposal-decisions';

const KNOWLEDGE_BASE = {
  domain: 'yuwen',
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

async function seedKnowledge(ids: string[]): Promise<void> {
  const db = testDb();
  const now = new Date();
  for (const id of ids) {
    await db.insert(knowledge).values({
      id,
      name: id,
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...KNOWLEDGE_BASE,
    });
  }
}

async function seedEdgeProposal(id = 'edge_p1'): Promise<void> {
  await seedKnowledge(['k1', 'k2']);
  await writeAiProposal(testDb(), {
    id,
    payload: {
      kind: 'knowledge_edge',
      target: { subject_kind: 'knowledge_edge', subject_id: null },
      reason_md: 'k1 unlocks k2',
      evidence_refs: [],
      proposed_change: {
        from_knowledge_id: 'k1',
        to_knowledge_id: 'k2',
        relation_type: 'prerequisite',
        weight: 0.7,
      },
    },
  });
}

async function seedNodeProposal(id = 'node_p1'): Promise<void> {
  await seedKnowledge(['seed:yuwen:shici']);
  await writeAiProposal(testDb(), {
    id,
    payload: {
      kind: 'knowledge_node',
      target: { subject_kind: 'knowledge', subject_id: null },
      reason_md: 'propose a new node',
      evidence_refs: [],
      proposed_change: { mutation: 'propose_new', name: '通假字', parent_id: 'seed:yuwen:shici' },
    },
  });
}

function decide(id: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://test/api/proposals/${id}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { id },
  );
}

type DecisionBody = {
  proposal_id: string;
  proposal_kind: string;
  decision: string;
  decision_event_id: string;
  proposal_status: string;
  created: boolean;
  idempotent: boolean;
  result: unknown;
};

describe('POST /api/proposals/[id]/decisions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates an immutable decision resource with a readable Location', async () => {
    await seedEdgeProposal();

    const res = await decide('edge_p1', { decision: 'accept' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as DecisionBody;
    expect(body).toMatchObject({
      proposal_id: 'edge_p1',
      proposal_kind: 'knowledge_edge',
      decision: 'accept',
      proposal_status: 'accepted',
      created: true,
      idempotent: false,
    });
    expect(body.decision_event_id).toBeTruthy();
    expect(res.headers.get('Location')).toBe(`/api/events/${body.decision_event_id}`);

    const detail = await getEventDetail(
      new Request(`http://test/api/events/${body.decision_event_id}`),
      { id: body.decision_event_id },
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { event: { id: string; action: string } };
    expect(detailBody.event).toMatchObject({ id: body.decision_event_id, action: 'rate' });
  });

  it('replays the same normalized decision without creating another event', async () => {
    await seedEdgeProposal();

    const first = await decide('edge_p1', { decision: 'accept' });
    const firstBody = (await first.json()) as DecisionBody;
    const replay = await decide('edge_p1', { decision: 'accept' });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as DecisionBody;
    expect(replayBody).toMatchObject({
      decision_event_id: firstBody.decision_event_id,
      created: false,
      idempotent: true,
    });
    // YUK-681 P2: the decision-resource idempotent short-circuit is gone, so a same-decision
    // replay now falls through to the applier, whose idempotent branch returns its own result
    // (previously the short-circuit returned `result: null` before the applier ran). No new
    // rate event is written — the applier self-guards idempotency.
    expect(replayBody.result).toMatchObject({ kind: 'knowledge_edge', idempotent: true });

    const rateRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'edge_p1')));
    expect(rateRows).toHaveLength(1);
  });

  it('makes knowledge_node re-accept idempotent (200, not a 409 conflict)', async () => {
    await seedNodeProposal();

    const first = await decide('node_p1', { decision: 'accept' });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as DecisionBody;
    expect(firstBody).toMatchObject({
      proposal_kind: 'knowledge_node',
      created: true,
      idempotent: false,
    });

    // YUK-681 P2: removing the decision-resource short-circuit routes re-accepts into the
    // applier, whose knowledge_node case now returns idempotently instead of throwing 409
    // (assertPending). This also fixes a prior inconsistency where the HTTP route replied 200
    // (via the short-circuit) while direct acceptAiProposal callers 409'd on the same re-accept.
    const replay = await decide('node_p1', { decision: 'accept' });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as DecisionBody;
    expect(replayBody).toMatchObject({
      decision_event_id: firstBody.decision_event_id,
      created: false,
      idempotent: true,
    });
    expect(replayBody.result).toMatchObject({ kind: 'knowledge_node', idempotent: true });

    const rateRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'node_p1')));
    expect(rateRows).toHaveLength(1);
  });

  it('keeps change_type re-decision idempotent (200, not 409)', async () => {
    await seedEdgeProposal();

    const first = await decide('edge_p1', { decision: 'change_type', new_relation_type: 'related_to' });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as DecisionBody;
    expect(firstBody).toMatchObject({ decision: 'change_type', created: true, idempotent: false });

    // YUK-681 P2: only `accept` falls through to the applier now; change_type/reverse must keep
    // their same-decision idempotent replay served by the resource, because acceptAiProposal's
    // top guard is accept-only and would 409 them (Codex review on the first cut of this PR).
    const replay = await decide('edge_p1', {
      decision: 'change_type',
      new_relation_type: 'related_to',
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      decision_event_id: firstBody.decision_event_id,
      created: false,
      idempotent: true,
      result: null,
    });
  });

  it('returns 409 when a different terminal decision already exists', async () => {
    await seedEdgeProposal();
    expect((await decide('edge_p1', { decision: 'accept' })).status).toBe(201);

    const conflict = await decide('edge_p1', { decision: 'dismiss' });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: 'conflict' });
  });

  it('models retract as a correction resource and makes retries idempotent', async () => {
    await seedEdgeProposal();
    expect((await decide('edge_p1', { decision: 'accept' })).status).toBe(201);

    const retract = await decide('edge_p1', {
      decision: 'retract',
      reason_md: '判断有误',
      affected_refs: [{ kind: 'question', id: 'q1' }],
    });
    expect(retract.status).toBe(201);
    const body = (await retract.json()) as DecisionBody;
    expect(body).toMatchObject({
      decision: 'retract',
      proposal_status: 'stale',
      created: true,
      idempotent: false,
    });

    const replay = await decide('edge_p1', { decision: 'retract' });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      decision_event_id: body.decision_event_id,
      created: false,
      idempotent: true,
    });

    const correctionRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'correct'), eq(event.subject_id, 'edge_p1')));
    expect(correctionRows).toHaveLength(1);
  });

  it('enforces the canonical decision vocabulary and option matrix', async () => {
    await seedEdgeProposal();
    expect((await decide('edge_p1', { decision: 'reject' })).status).toBe(400);
    expect((await decide('edge_p1', { decision: 'change_type' })).status).toBe(400);
    expect(
      (
        await decide('edge_p1', {
          decision: 'accept',
          new_relation_type: 'related_to',
        })
      ).status,
    ).toBe(400);
    expect(
      (await decide('edge_p1', { decision: 'accept', reason_md: 'only for retract' })).status,
    ).toBe(400);
  });

  it('returns 404 for an unknown proposal', async () => {
    expect((await decide('missing', { decision: 'accept' })).status).toBe(404);
  });
});
