import { MASTERY_PROGRESS_ACTION } from '@/capabilities/notes/server/mastery-progress-signal';
import { event, knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadEffectivenessTrend } from './effectiveness-trend';
// NB: pure `summarizeTrend` / `rollupSubjectDirection` confidence-ladder + boundary
// coverage lives in the no-DB unit lane (effectiveness-trend-summary.unit.test.ts).
// This file covers the DB-assembled read model (loadEffectivenessTrend) end-to-end.

const db = testDb();
const NOW = new Date('2026-06-28T08:00:00Z');

async function seedKc(
  id: string,
  name: string,
  opts: { domain?: string | null; parent_id?: string | null } = {},
) {
  await db.insert(knowledge).values({
    id,
    name,
    domain: opts.domain === undefined ? 'wenyan' : opts.domain,
    parent_id: opts.parent_id ?? null,
    merged_from: [],
    archived_at: null,
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
  knowledge_id: string;
  created_at: Date;
  theta_hat: number | null;
  p_learned?: number | null;
  theta_delta?: number | null;
}) {
  eventSeq += 1;
  await db.insert(event).values({
    id: `ev_mp_${eventSeq}`,
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
async function seedTrajectory(knowledgeId: string, thetas: number[]) {
  for (let i = 0; i < thetas.length; i++) {
    await seedMasteryProgress({
      knowledge_id: knowledgeId,
      created_at: new Date(NOW.getTime() + i * 60_000),
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
    const { series, aggregate } = await loadEffectivenessTrend(db);
    expect(series).toEqual([]);
    expect(aggregate.total_kcs_with_activity).toBe(0);
    expect(aggregate.total_events).toBe(0);
    expect(aggregate.by_subject).toEqual([]);
  });

  it('builds a per-KC ascending time series with name + effective_domain', async () => {
    await seedKc('k_rise', '宾语前置', { domain: 'wenyan' });
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

    const { series } = await loadEffectivenessTrend(db);
    expect(series).toHaveLength(1);
    const s = series[0];
    expect(s.knowledge_id).toBe('k_rise');
    expect(s.name).toBe('宾语前置');
    expect(s.effective_domain).toBe('wenyan');
    expect(s.activity_count).toBe(2);
    // ascending by created_at
    expect(s.points.map((p) => p.theta_hat)).toEqual([-0.1, 0.3]);
    expect(s.points[0].at < s.points[1].at).toBe(true);
  });

  it('classifies rising / holding / falling per KC from the trajectory', async () => {
    await seedKc('k_up', '上升', { domain: 'wenyan' });
    await seedKc('k_flat', '持平', { domain: 'wenyan' });
    await seedKc('k_down', '退步', { domain: 'wenyan' });
    await seedTrajectory('k_up', [-0.4, -0.2, 0.0, 0.3, 0.6, 0.9, 1.2, 1.5]);
    await seedTrajectory('k_flat', [0.42, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42]);
    await seedTrajectory('k_down', [1.5, 1.2, 0.9, 0.6, 0.3, 0.0, -0.3, -0.6]);

    const { series } = await loadEffectivenessTrend(db);
    const byId = new Map(series.map((s) => [s.knowledge_id, s]));
    expect(byId.get('k_up')?.trend.direction).toBe('rising');
    expect(byId.get('k_flat')?.trend.direction).toBe('holding');
    expect(byId.get('k_down')?.trend.direction).toBe('falling');
  });

  it('marks insufficient + no mastery signal for a single-attempt KC', async () => {
    await seedKc('k_one', '单次', { domain: 'wenyan' });
    await seedMasteryProgress({ knowledge_id: 'k_one', created_at: NOW, theta_hat: 0.2 });

    const { series } = await loadEffectivenessTrend(db);
    const s = series.find((x) => x.knowledge_id === 'k_one');
    expect(s?.trend.direction).toBe('insufficient');
    expect(s?.trend.has_mastery_signal).toBe(false);
    // activity proxy still available for the UI fallback
    expect(s?.activity_count).toBe(1);
  });

  it('rolls up per-subject along the derived effective_domain axis (inherited from parent)', async () => {
    // wenyan root + child that inherits domain via parent walk
    await seedKc('k_root', '文言根', { domain: 'wenyan', parent_id: null });
    await seedKc('k_child', '子节点', { domain: null, parent_id: 'k_root' });
    // a second subject
    await seedKc('k_math', '代数', { domain: 'math', parent_id: null });

    await seedTrajectory('k_root', [-0.4, -0.2, 0.0, 0.3, 0.6, 0.9, 1.2, 1.5]); // rising
    await seedTrajectory('k_child', [-0.3, -0.1, 0.1, 0.4, 0.7, 1.0, 1.3, 1.6]); // rising, inherits wenyan
    await seedTrajectory('k_math', [0.42, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42]); // holding

    const { series, aggregate } = await loadEffectivenessTrend(db);

    // child inherits wenyan via parent walk
    expect(series.find((s) => s.knowledge_id === 'k_child')?.effective_domain).toBe('wenyan');

    const bySubject = new Map(aggregate.by_subject.map((r) => [r.effective_domain, r]));
    const wenyan = bySubject.get('wenyan');
    expect(wenyan?.kc_count).toBe(2);
    expect(wenyan?.kc_with_mastery_signal).toBe(2);
    expect(wenyan?.direction).toBe('rising');
    expect(wenyan?.activity_count).toBe(16);

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

    const { series, aggregate } = await loadEffectivenessTrend(db);
    const s = series.find((x) => x.knowledge_id === 'k_open');
    expect(s?.trend.has_mastery_signal).toBe(false);
    expect(s?.activity_count).toBe(6);

    const humanities = aggregate.by_subject.find((r) => r.effective_domain === 'humanities');
    expect(humanities?.direction).toBe('insufficient');
    expect(humanities?.kc_with_mastery_signal).toBe(0);
    // activity proxy survives so the UI can show activity instead of a fake mastery trend
    expect(humanities?.activity_count).toBe(6);
    expect(aggregate.total_events).toBe(6);
  });
});
