import { MASTERY_PROGRESS_ACTION } from '@/core/schema/event';
import { event, knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { EffectivenessTrendResponseSchema } from '../api/diagnostic-contracts';
import { loadEffectivenessTrend } from './effectiveness-trend';
// NB: pure `summarizeTrend` / `rollupSubjectDirection` confidence-ladder + boundary
// coverage lives in the no-DB unit lane (effectiveness-trend-summary.unit.test.ts).
// This file covers the DB-assembled read model (loadEffectivenessTrend) end-to-end.

const db = testDb();
const NOW = new Date('2026-06-28T08:00:00Z');
const AS_OF = new Date('2026-06-29T08:00:00Z');

async function seedKc(
  id: string,
  name: string,
  opts: {
    domain?: string | null;
    parent_id?: string | null;
    archived_at?: Date | null;
  } = {},
) {
  await db.insert(knowledge).values({
    id,
    name,
    domain: opts.domain === undefined ? 'yuwen' : opts.domain,
    parent_id: opts.parent_id ?? null,
    merged_from: [],
    archived_at: opts.archived_at ?? null,
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

let eventSeq = 0;

// 直接 INSERT 一条 mastery_progress 事件（测试 fixture 可绕 writeEvent，见 event-seed.ts 注释）。
async function seedMasteryProgress(opts: {
  id?: string;
  knowledge_id: string;
  created_at: Date;
  theta_hat: number | null;
  p_learned?: number | null;
  theta_delta?: number | null;
}) {
  eventSeq += 1;
  await db.insert(event).values({
    id: opts.id ?? `ev_mp_${eventSeq}`,
    session_id: null,
    actor_kind: 'system',
    actor_ref: 'mastery_progress_signal',
    action: MASTERY_PROGRESS_ACTION,
    subject_kind: 'knowledge',
    subject_id: opts.knowledge_id,
    outcome: null,
    payload: {
      knowledge_id: opts.knowledge_id,
      theta_delta: opts.theta_delta ?? null,
      p_learned: opts.p_learned ?? null,
      theta_hat: opts.theta_hat,
      threshold_deferred: true,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at,
  });
}

// 在一个 KC 上播一串等间隔 θ̂ 轨迹（按给定 θ̂ 数组升序时间）。
async function seedTrajectory(knowledgeId: string, thetas: number[], latestAt = NOW) {
  for (let i = 0; i < thetas.length; i++) {
    await seedMasteryProgress({
      knowledge_id: knowledgeId,
      created_at: new Date(latestAt.getTime() - (thetas.length - 1 - i) * 86_400_000),
      theta_hat: thetas[i],
      p_learned: 1 / (1 + Math.exp(-thetas[i])),
      theta_delta: i === 0 ? null : thetas[i] - thetas[i - 1],
    });
  }
}

describe('loadEffectivenessTrend read model', () => {
  beforeEach(async () => {
    await resetDb();
    eventSeq = 0;
  });

  it('returns an empty series + zeroed aggregate when no mastery_progress events exist', async () => {
    await seedKc('k_idle', '没作答');
    const { series, aggregate } = await loadEffectivenessTrend(db, AS_OF);
    expect(series).toEqual([]);
    expect(aggregate.total_kcs_with_activity).toBe(0);
    expect(aggregate.total_events).toBe(0);
    expect(aggregate.by_subject).toEqual([]);
  });

  it('builds a per-KC ascending time series with name + effective_domain', async () => {
    await seedKc('k_rise', '宾语前置', { domain: 'yuwen' });
    // seed out of chronological order to prove the read model sorts by created_at
    await seedMasteryProgress({
      knowledge_id: 'k_rise',
      created_at: new Date(NOW.getTime() + 2000),
      theta_hat: 0.3,
      p_learned: 0.57,
      theta_delta: 0.2,
    });
    await seedMasteryProgress({
      knowledge_id: 'k_rise',
      created_at: NOW,
      theta_hat: -0.1,
      p_learned: 0.47,
      theta_delta: null,
    });

    const result = await loadEffectivenessTrend(db, AS_OF);
    EffectivenessTrendResponseSchema.parse(JSON.parse(JSON.stringify(result)));
    const { series } = result;
    expect(series).toHaveLength(0);
    expect(result.aggregate.total_kcs_with_activity).toBe(1);
    expect(result.aggregate.total_events).toBe(2);
  });

  it('classifies rising / holding / falling per KC from the trajectory', async () => {
    await seedKc('k_up', '上升', { domain: 'yuwen' });
    await seedKc('k_flat', '持平', { domain: 'yuwen' });
    await seedKc('k_down', '退步', { domain: 'yuwen' });
    await seedTrajectory('k_up', [-0.4, -0.2, 0.0, 0.3, 0.6, 0.9, 1.2, 1.5]);
    await seedTrajectory('k_flat', [0.42, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42]);
    await seedTrajectory('k_down', [1.5, 1.2, 0.9, 0.6, 0.3, 0.0, -0.3, -0.6]);

    const { series } = await loadEffectivenessTrend(db, AS_OF);
    const byId = new Map(series.map((s) => [s.knowledge_id, s]));
    expect(byId.get('k_up')?.trend.direction).toBe('rising');
    expect(byId.get('k_flat')).toBeUndefined();
    expect(byId.get('k_down')?.trend.direction).toBe('falling');
  });

  it('marks insufficient + no mastery signal for a single-attempt KC', async () => {
    await seedKc('k_one', '单次', { domain: 'yuwen' });
    await seedMasteryProgress({ knowledge_id: 'k_one', created_at: NOW, theta_hat: 0.2 });

    const result = await loadEffectivenessTrend(db, AS_OF);
    expect(result.series).toEqual([]);
    expect(result.aggregate.total_kcs_with_activity).toBe(1);
    expect(result.aggregate.total_events).toBe(1);
  });

  it('rolls up per-subject along the derived effective_domain axis (inherited from parent)', async () => {
    // yuwen root + child that inherits domain via parent walk
    await seedKc('k_root', '文言根', { domain: 'yuwen', parent_id: null });
    await seedKc('k_child', '子节点', { domain: null, parent_id: 'k_root' });
    // a second subject
    await seedKc('k_math', '代数', { domain: 'math', parent_id: null });

    await seedTrajectory('k_root', [-0.4, -0.2, 0.0, 0.3, 0.6, 0.9, 1.2, 1.5]); // rising
    await seedTrajectory('k_child', [-0.3, -0.1, 0.1, 0.4, 0.7, 1.0, 1.3, 1.6]); // rising, inherits yuwen
    await seedTrajectory('k_math', [0.42, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42]); // holding

    const { series, aggregate } = await loadEffectivenessTrend(db, AS_OF);

    // child inherits yuwen via parent walk
    expect(series.find((s) => s.knowledge_id === 'k_child')?.effective_domain).toBe('yuwen');

    const bySubject = new Map(aggregate.by_subject.map((r) => [r.effective_domain, r]));
    const yuwen = bySubject.get('yuwen');
    expect(yuwen?.kc_count).toBe(2);
    expect(yuwen?.kc_with_mastery_signal).toBe(2);
    expect(yuwen?.direction).toBe('rising');
    expect(yuwen?.activity_count).toBe(16);

    const math = bySubject.get('math');
    expect(math?.kc_count).toBe(1);
    expect(math?.direction).toBe('holding');
  });

  it('subject with only degenerate KCs (null theta) rolls up to insufficient but keeps activity count', async () => {
    await seedKc('k_open', '开放题KC', { domain: 'humanities' });
    // events exist (activity) but theta_hat is null → IRT degenerate, no credible mastery trend
    for (let i = 0; i < 6; i++) {
      await seedMasteryProgress({
        knowledge_id: 'k_open',
        created_at: new Date(NOW.getTime() + i * 60_000),
        theta_hat: null,
        p_learned: null,
        theta_delta: null,
      });
    }

    const { series, aggregate } = await loadEffectivenessTrend(db, AS_OF);
    expect(series).toEqual([]);

    const humanities = aggregate.by_subject.find((r) => r.effective_domain === 'humanities');
    expect(humanities?.direction).toBe('insufficient');
    expect(humanities?.kc_with_mastery_signal).toBe(0);
    // activity proxy survives so the UI can show activity instead of a fake mastery trend
    expect(humanities?.activity_count).toBe(6);
    expect(aggregate.total_events).toBe(6);
  });

  it('bounds the response to 30 Shanghai calendar days, keeps one latest point per KC/day, and preserves raw activity', async () => {
    await seedKc('k_daily', '每日去重');
    await seedTrajectory('k_daily', [-0.8, -0.6, -0.4], new Date('2026-06-27T02:00:00Z'));
    await seedMasteryProgress({
      id: 'ev_a',
      knowledge_id: 'k_daily',
      created_at: new Date('2026-06-28T02:00:00Z'),
      theta_hat: 0.1,
    });
    await seedMasteryProgress({
      id: 'ev_z',
      knowledge_id: 'k_daily',
      created_at: new Date('2026-06-28T02:00:00Z'),
      theta_hat: 0.4,
    });
    await seedMasteryProgress({
      knowledge_id: 'k_daily',
      created_at: new Date('2026-05-30T15:59:59Z'),
      theta_hat: -1,
    });
    await seedMasteryProgress({
      knowledge_id: 'k_daily',
      created_at: new Date('2026-06-29T09:00:00Z'),
      theta_hat: 9,
    });

    const result = await loadEffectivenessTrend(db, AS_OF);
    expect(result.metadata).toEqual({
      as_of: AS_OF.toISOString(),
      window_start: '2026-05-30T16:00:00.000Z',
      window_end: AS_OF.toISOString(),
      timezone: 'Asia/Shanghai',
      granularity: 'calendar_day',
      notable_limit: 6,
      eligible: 1,
      returned: 1,
      truncated: false,
    });
    expect(result.series).toHaveLength(1);
    expect(result.series[0].points.at(-1)).toMatchObject({
      at: '2026-06-28T02:00:00.000Z',
      theta_hat: 0.4,
    });
    expect(result.series[0].trend.direction).toBe('rising');
    expect(result.aggregate.total_kcs_with_activity).toBe(1);
    expect(result.aggregate.total_events).toBe(5);
  });

  it('resolves an active KC domain through an archived intermediate ancestor', async () => {
    await seedKc('k_root_arch', '根', { domain: 'yuwen' });
    await seedKc('k_mid_arch', '归档中间节点', {
      domain: null,
      parent_id: 'k_root_arch',
      archived_at: NOW,
    });
    await seedKc('k_leaf_active', '有效叶节点', {
      domain: null,
      parent_id: 'k_mid_arch',
    });
    await seedTrajectory('k_leaf_active', [-1, -0.8, -0.5, -0.2, 0.2, 0.6, 1, 1.4]);

    const result = await loadEffectivenessTrend(db, AS_OF);
    expect(result.series.map((row) => [row.knowledge_id, row.effective_domain])).toContainEqual([
      'k_leaf_active',
      'yuwen',
    ]);
    expect(result.aggregate.total_kcs_with_activity).toBe(1);
  });

  it('breaks equal private-magnitude ties by latest recency, then binary knowledge id', async () => {
    const same = [-1, -0.8, -0.5, -0.2, 0.2, 0.6, 1, 1.4];
    await seedKc('k_z_old', '旧');
    await seedKc('k_b_new', '新 B');
    await seedKc('k_A_new', '新 A');
    await seedTrajectory('k_z_old', same, new Date(NOW.getTime() - 60_000));
    await seedTrajectory('k_b_new', same, NOW);
    await seedTrajectory('k_A_new', same, NOW);

    const result = await loadEffectivenessTrend(db, AS_OF);
    expect(result.series.map((row) => row.knowledge_id)).toEqual(['k_A_new', 'k_b_new', 'k_z_old']);
  });

  it('recognizes only canonical subject-root ids', async () => {
    await seedKc('seed:yuwen:root', '规范根');
    await seedKc('seed:a:b:root', '非规范多冒号 ID');
    const rising = [-1, -0.8, -0.5, -0.2, 0.2, 0.6, 1, 1.4];
    await seedTrajectory('seed:yuwen:root', rising);
    await seedTrajectory('seed:a:b:root', rising);

    const result = await loadEffectivenessTrend(db, AS_OF);
    expect(result.subject_roots.map((row) => row.knowledge_id)).toEqual(['seed:yuwen:root']);
    expect(result.series.map((row) => row.knowledge_id)).toContain('seed:a:b:root');
  });

  it('globally returns at most six non-root moved KCs while aggregates cover every active KC', async () => {
    await seedKc('seed:yuwen:root', '语文根');
    await seedTrajectory('seed:yuwen:root', [-1, -0.8, -0.6, -0.4, 0, 0.4, 0.8, 1.2]);
    for (let i = 0; i < 8; i++) {
      const id = `k_${i}`;
      await seedKc(id, id, { parent_id: 'seed:yuwen:root', domain: null });
      await seedTrajectory(id, [
        -1,
        -0.8,
        -0.6,
        -0.4,
        i / 10,
        0.5 + i / 10,
        1 + i / 10,
        1.5 + i / 10,
      ]);
    }
    await seedKc('k_flat_all', '持平', { parent_id: 'seed:yuwen:root', domain: null });
    await seedTrajectory('k_flat_all', Array(8).fill(0.2));

    const result = await loadEffectivenessTrend(db, AS_OF);
    expect(result.series).toHaveLength(6);
    expect(result.subject_roots.map((row) => row.knowledge_id)).toEqual(['seed:yuwen:root']);
    expect(result.metadata).toMatchObject({ eligible: 8, returned: 6, truncated: true });
    expect(result.aggregate.total_kcs_with_activity).toBe(10);
    expect(result.aggregate.by_subject[0].kc_count).toBe(10);
    expect(JSON.stringify(result)).not.toContain('magnitude');
  });
});
