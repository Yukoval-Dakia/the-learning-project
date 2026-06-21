// M4-T5 (YUK-319)：GET /api/workbench/summary 聚合测试——空库形态（全零 +
// week_heat 七天补零）+ 种子形态（archived 排除 / 提议 KPI / review 会话
// reviewed_count / week_heat 今日计数）。

import { event, goal, knowledge, learning_session } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET as getWorkbenchSummary } from './workbench-summary';

const KNOWLEDGE_BASE = {
  domain: 'wenyan',
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

interface SummaryBody {
  proposals: { total: number; by_kind: Record<string, number>; status: string };
  kpi: {
    due_count: number;
    pending_attribution_count: number;
    knowledge_count: number;
    goal_count: number;
  };
  active_sessions: Array<{
    id: string;
    status: string;
    summary_md: string | null;
    started_at: number;
    ended_at: number | null;
    duration_ms: number | null;
    reviewed_count: number;
  }>;
  week_heat: Array<{ day: string; count: number }>;
}

async function fetchSummary(): Promise<SummaryBody> {
  const res = await getWorkbenchSummary();
  expect(res.status).toBe(200);
  return (await res.json()) as SummaryBody;
}

describe('GET /api/workbench/summary (shell)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns a zeroed summary on an empty database', async () => {
    const body = await fetchSummary();

    expect(body.proposals.total).toBe(0);
    expect(body.proposals.status).toBe('pending');
    expect(body.kpi).toEqual({
      due_count: 0,
      pending_attribution_count: 0,
      knowledge_count: 0,
      // 冷库无 active goal → 0（YUK-473 Slice 1 冷启动拦截信号）。
      goal_count: 0,
    });
    expect(body.active_sessions).toEqual([]);

    expect(body.week_heat).toHaveLength(7);
    for (const dayRow of body.week_heat) {
      expect(dayRow.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(dayRow.count).toBe(0);
    }
    // 升序、不重复（generate_series 逐日补零）。
    const days = body.week_heat.map((d) => d.day);
    expect([...new Set(days)].sort()).toEqual(days);
  });

  it('aggregates seeded knowledge / proposals / review sessions / heat', async () => {
    const db = testDb();
    const now = new Date();

    // knowledge_count 排除 archived：k1 计入，k2 不计。
    for (const [id, archivedAt] of [
      ['k1', null],
      ['k2', now],
    ] as const) {
      await db.insert(knowledge).values({
        id,
        name: id,
        archived_at: archivedAt,
        created_at: now,
        updated_at: now,
        ...KNOWLEDGE_BASE,
      });
    }

    await writeAiProposal(db, {
      id: 'edge_p1',
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

    // goal_count 数 active goal：g1（active）计入，g2（done）不计——YUK-473 Slice 1。
    for (const [id, status] of [
      ['g1', 'active'],
      ['g2', 'done'],
    ] as const) {
      await db.insert(goal).values({
        id,
        title: id,
        status,
        source: 'manual',
        created_at: now,
        updated_at: now,
      });
    }

    const startedAt = new Date(now.getTime() - 60_000);
    await db.insert(learning_session).values({
      id: 's1',
      type: 'review',
      status: 'completed',
      summary_md: '复习了 2 题',
      started_at: startedAt,
      ended_at: now,
    });
    for (const id of ['evt_review_1', 'evt_review_2']) {
      await db.insert(event).values({
        id,
        session_id: 's1',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'review',
        subject_kind: 'question',
        subject_id: `q_${id}`,
        payload: { fsrs_rating: 'good' },
      });
    }

    const body = await fetchSummary();

    expect(body.proposals.total).toBe(1);
    // by_kind 是全 kind 零值映射（loadTodayProposalKpi 口径），只断言命中键。
    expect(body.proposals.by_kind.knowledge_edge).toBe(1);
    expect(body.kpi.knowledge_count).toBe(1);
    expect(body.kpi.due_count).toBe(0);
    expect(body.kpi.pending_attribution_count).toBe(0);
    // active goal g1 计入、done goal g2 排除 → 1（YUK-473 Slice 1）。
    expect(body.kpi.goal_count).toBe(1);

    expect(body.active_sessions).toHaveLength(1);
    expect(body.active_sessions[0]).toMatchObject({
      id: 's1',
      status: 'completed',
      summary_md: '复习了 2 题',
      started_at: Math.floor(startedAt.getTime() / 1000),
      ended_at: Math.floor(now.getTime() / 1000),
      duration_ms: now.getTime() - startedAt.getTime(),
      reviewed_count: 2,
    });

    // 今日（BJT，末位元素）至少含 2 review event + 1 propose event。
    expect(body.week_heat).toHaveLength(7);
    expect(body.week_heat[6].count).toBeGreaterThanOrEqual(3);
  });
});
