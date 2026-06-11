// M4-T5 (YUK-319/YUK-318)：shell 包 proposals 路由测试。覆盖：list 等价平移
// （status/limit 校验）+ kind 增量过滤 + YUK-318 回归（accept 后退出 pending
// 视图）+ decide 四值 dispatch + retract C1 红线 + 换源等价断言（Critic m1：
// 纯 pending 集合下新源 == 旧 /api/events 裸查语义，accept 后两源分叉）。

import { event, knowledge } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST as decideProposal } from './proposal-decide';
import { POST as retractProposal } from './proposal-retract';
import { GET as listProposals } from './proposals-list';

const KNOWLEDGE_BASE = {
  domain: 'wenyan',
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

async function seedEdgeProposal(id: string, from: string, to: string): Promise<void> {
  await writeAiProposal(testDb(), {
    id,
    payload: {
      kind: 'knowledge_edge',
      target: { subject_kind: 'knowledge_edge', subject_id: null },
      reason_md: `${from} unlocks ${to}`,
      evidence_refs: [],
      proposed_change: {
        from_knowledge_id: from,
        to_knowledge_id: to,
        relation_type: 'prerequisite',
        weight: 0.7,
      },
    },
  });
}

async function seedLearningItemProposal(id: string): Promise<void> {
  await writeAiProposal(testDb(), {
    id,
    payload: {
      kind: 'learning_item',
      target: { subject_kind: 'learning_item', subject_id: null },
      reason_md: 'Create a focused review item',
      evidence_refs: [],
      proposed_change: { title: '虚词复习' },
    },
  });
}

function listRequest(query = ''): Request {
  return new Request(`http://test/api/proposals${query}`);
}

function postJson(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function decideRequest(id: string, body: unknown): [Request, Record<string, string>] {
  return [postJson(`http://test/api/proposals/${id}/decide`, body), { id }];
}

describe('GET /api/proposals (shell)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('lists seeded proposals without query params', async () => {
    await seedKnowledge(['k1', 'k2']);
    await seedEdgeProposal('edge_p1', 'k1', 'k2');

    const res = await listProposals(listRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ id: string; kind: string; status: string }>;
      next_cursor: string | null;
    };
    expect(body.rows.map((r) => r.id)).toContain('edge_p1');
    const row = body.rows.find((r) => r.id === 'edge_p1');
    expect(row).toMatchObject({ kind: 'knowledge_edge', status: 'pending' });
    expect(body.next_cursor).toBeNull();
  });

  it('filters by status; accepted proposals leave the pending view (YUK-318)', async () => {
    await seedKnowledge(['k1', 'k2', 'k3']);
    await seedEdgeProposal('edge_p1', 'k1', 'k2');
    await seedEdgeProposal('edge_p2', 'k2', 'k3');

    const decided = await decideProposal(...decideRequest('edge_p1', { decision: 'accept' }));
    expect(decided.status).toBe(200);

    const pendingRes = await listProposals(listRequest('?status=pending'));
    expect(pendingRes.status).toBe(200);
    const pending = (await pendingRes.json()) as { rows: Array<{ id: string }> };
    expect(pending.rows.map((r) => r.id)).toEqual(['edge_p2']);

    const acceptedRes = await listProposals(listRequest('?status=accepted'));
    const accepted = (await acceptedRes.json()) as { rows: Array<{ id: string }> };
    expect(accepted.rows.map((r) => r.id)).toContain('edge_p1');
  });

  it('filters by kind within the page', async () => {
    await seedKnowledge(['k1', 'k2']);
    await seedEdgeProposal('edge_p1', 'k1', 'k2');
    await seedLearningItemProposal('learning_p1');

    const edgeRes = await listProposals(listRequest('?kind=knowledge_edge'));
    expect(edgeRes.status).toBe(200);
    const edges = (await edgeRes.json()) as { rows: Array<{ id: string }> };
    expect(edges.rows.map((r) => r.id)).toEqual(['edge_p1']);

    const noteRes = await listProposals(listRequest('?kind=note_update'));
    const notes = (await noteRes.json()) as { rows: Array<{ id: string }> };
    expect(notes.rows).toEqual([]);

    const invalidRes = await listProposals(listRequest('?kind=bogus'));
    expect(invalidRes.status).toBe(400);
  });

  it('rejects invalid status and limit', async () => {
    expect((await listProposals(listRequest('?status=bogus'))).status).toBe(400);
    expect((await listProposals(listRequest('?limit=0'))).status).toBe(400);
    expect((await listProposals(listRequest('?limit=abc'))).status).toBe(400);
  });
});

describe('POST /api/proposals/[id]/decide (shell)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('accept dispatches to acceptAiProposal and writes a rate event', async () => {
    await seedKnowledge(['k1', 'k2']);
    await seedEdgeProposal('edge_p1', 'k1', 'k2');

    const res = await decideProposal(...decideRequest('edge_p1', { decision: 'accept' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('knowledge_edge');

    const db = testDb();
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'edge_p1')));
    expect(rateRows).toHaveLength(1);
    expect((rateRows[0].payload as { rating?: string }).rating).toBe('accept');
  });

  it('dismiss dispatches to dismissAiProposal', async () => {
    await seedKnowledge(['k1', 'k2']);
    await seedEdgeProposal('edge_p1', 'k1', 'k2');

    const res = await decideProposal(
      ...decideRequest('edge_p1', { decision: 'dismiss', user_note: '不需要这条边' }),
    );
    expect(res.status).toBe(200);

    const db = testDb();
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'edge_p1')));
    expect(rateRows).toHaveLength(1);
    expect((rateRows[0].payload as { rating?: string }).rating).toBe('dismiss');
  });

  it('rejects change_type without new_relation_type', async () => {
    await seedKnowledge(['k1', 'k2']);
    await seedEdgeProposal('edge_p1', 'k1', 'k2');

    const res = await decideProposal(...decideRequest('edge_p1', { decision: 'change_type' }));
    expect(res.status).toBe(400);
  });

  it('rejects a body without decision', async () => {
    await seedKnowledge(['k1', 'k2']);
    await seedEdgeProposal('edge_p1', 'k1', 'k2');

    const res = await decideProposal(...decideRequest('edge_p1', {}));
    expect(res.status).toBe(400);
  });

  it('repeat same decision is idempotent; conflicting decision returns 409', async () => {
    await seedKnowledge(['k1', 'k2']);
    await seedEdgeProposal('edge_p1', 'k1', 'k2');

    const first = await decideProposal(...decideRequest('edge_p1', { decision: 'accept' }));
    expect(first.status).toBe(200);

    // 同决策重复：幂等 200（ensureProposalDecisionSignal 对账，不重写边）。
    const repeat = await decideProposal(...decideRequest('edge_p1', { decision: 'accept' }));
    expect(repeat.status).toBe(200);

    // 冲突决策：already decided as accept → 409。
    const conflict = await decideProposal(...decideRequest('edge_p1', { decision: 'dismiss' }));
    expect(conflict.status).toBe(409);
  });
});

describe('POST /api/proposals/[id]/retract (shell)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('retracts an accepted proposal and writes a correct event (C1)', async () => {
    await seedKnowledge(['k1', 'k2']);
    await seedEdgeProposal('edge_p1', 'k1', 'k2');
    const accepted = await decideProposal(...decideRequest('edge_p1', { decision: 'accept' }));
    expect(accepted.status).toBe(200);

    const res = await retractProposal(
      postJson('http://test/api/proposals/edge_p1/retract', { reason_md: '判断有误' }),
      { id: 'edge_p1' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('retracted');

    const db = testDb();
    const correctionRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'correct'), eq(event.subject_id, 'edge_p1')));
    expect(correctionRows).toHaveLength(1);
    expect(correctionRows[0].caused_by_event_id).toBe('edge_p1');
    expect(correctionRows[0].payload).toMatchObject({
      correction_kind: 'retract',
      reason_md: '判断有误',
    });
  });
});

describe('knowledge UI 换源等价 (Critic m1, YUK-318)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('matches the legacy raw propose-event query for pure-pending sets and diverges after accept', async () => {
    await seedKnowledge(['k1', 'k2', 'k3', 'k4']);
    await seedEdgeProposal('edge_a', 'k1', 'k2');
    await seedEdgeProposal('edge_b', 'k2', 'k3');
    await seedEdgeProposal('edge_c', 'k3', 'k4');

    const db = testDb();
    // 旧源：knowledge UI 在 /api/events 上的裸查语义（propose × knowledge_edge ×
    // outcome success|partial），客户端再按 decided 集合过滤——服务端无 status 概念。
    const legacyQuery = () =>
      db
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.action, 'propose'),
            eq(event.subject_kind, 'knowledge_edge'),
            inArray(event.outcome, ['success', 'partial']),
          ),
        );

    const listIds = async () => {
      const res = await listProposals(listRequest('?kind=knowledge_edge&status=pending'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: Array<{ id: string }> };
      return body.rows.map((r) => r.id).sort();
    };

    // 纯 pending 集合：两源等价。
    const legacyBefore = (await legacyQuery()).map((r) => r.id).sort();
    expect(await listIds()).toEqual(legacyBefore);
    expect(legacyBefore).toHaveLength(3);

    // accept 一条后分叉：旧裸查不感知决策仍 3 行（YUK-318 修的正是这点），
    // 新源 pending 视图收缩到 2 行。
    const decided = await decideProposal(...decideRequest('edge_a', { decision: 'accept' }));
    expect(decided.status).toBe(200);

    expect(await legacyQuery()).toHaveLength(3);
    expect(await listIds()).toEqual(['edge_b', 'edge_c']);
  });
});
