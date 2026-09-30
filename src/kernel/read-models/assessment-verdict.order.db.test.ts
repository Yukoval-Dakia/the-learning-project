// YUK-1106 — 裁决读模型 candidate 顺序确定性的真实 Postgres 回归。
//
// 背景：judgeCandidatesForAttempts 无 ORDER BY ⇒ 候选返回顺序由 planner/堆序
// 决定；当多个候选链解析到同一 effective 行时（j_old supersede→j_new 与 j_new
// 自链），聚合 loop 的 comparison 不更新、先到者 truth 保留 ⇒ effective.
// original_event_id 取决于返回顺序（CI run 36444482025 的 flaky RED）。
//
// 修复：候选去重后按仓库规范序（created_at, dispatch_seq, id）升序处理——
// 同一 effective 端点的最早链来源（链根）先到并保留。本文件在**真实
// testcontainer Postgres** 上钉住：
//   1. 反向物理插入序（j_new 行先落库、j_old created_at 更早）——堆序最可能
//      返回 j_new 在前；结果必须仍是 j_old 链来源（顺序无关性）。
//   2. 多跳链 j1→j2→j3：effective 行=j3 且链来源=链根 j1（不是中间 j2）。
//   3. 独立新判（无 supersede 关系的两条 active 判）：effective=最新行、
//      provenance 是它自己的链（不伪造改判来源）。
//   4. 同 created_at 同 dispatch_seq 平局：id 决定 newest/effective；original
//      取 id 较小者（仓库规范比较器 newEventRow 的 tie-break 语义）。
//
// 证明边界（诚实声明）：真实 DB 无法稳定强制 planner 返回顺序——顺序确定性的
// 确定性证明在 assessment-verdict.candidate-order.unit.test.ts（SQL seam 控制
// 正反序）；本文件钉的是修复后真实 Postgres 上的业务契约。
import { beforeEach, describe, expect, it } from 'vitest';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { resolveVerdictsForAttempts } from './assessment-verdict';

const T0 = new Date('2026-09-26T00:00:00Z');
const T1 = new Date('2026-09-26T00:01:00Z');
const T2 = new Date('2026-09-26T00:02:00Z');
const T3 = new Date('2026-09-26T00:03:00Z');

async function seedAttempt(id: string, createdAt = T0): Promise<void> {
  await writeEvent(testDb(), {
    id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: `q_${id}`,
    outcome: 'failure',
    payload: { answer_md: 'wrong', answer_image_refs: [], referenced_knowledge_ids: [] },
    created_at: createdAt,
  });
}

async function seedJudge(opts: {
  id: string;
  attemptEventId: string;
  causedBy?: string;
  coarseOutcome: string;
  score?: number;
  actorRef?: string;
  appealEventId?: string;
  createdAt: Date;
}): Promise<void> {
  await writeEvent(testDb(), {
    id: opts.id,
    actor_kind: 'agent',
    actor_ref: opts.actorRef ?? 'paper_judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: opts.attemptEventId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'other',
        secondary_categories: [],
        analysis_md: '<test>',
        confidence: 0.9,
      },
      referenced_knowledge_ids: ['kc_a'],
      coarse_outcome: opts.coarseOutcome,
      ...(opts.score !== undefined ? { score: opts.score } : {}),
      feedback_md: `fb_${opts.id}`,
      ...(opts.appealEventId ? { appeal_event_id: opts.appealEventId } : {}),
    },
    caused_by_event_id: opts.causedBy ?? opts.attemptEventId,
    created_at: opts.createdAt,
  });
}

async function seedCorrection(opts: {
  id: string;
  targetEventId: string;
  correctionKind: 'supersede' | 'retract' | 'mark_wrong';
  replacementEventId?: string;
  causedBy?: string;
  createdAt: Date;
}): Promise<void> {
  await writeEvent(testDb(), {
    id: opts.id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: opts.targetEventId,
    outcome: 'success',
    payload: {
      correction_kind: opts.correctionKind,
      replacement_event_id: opts.replacementEventId,
      reason_md: 'test correction',
      affected_refs: [{ kind: 'question', id: 'q' }],
    },
    caused_by_event_id: opts.causedBy,
    created_at: opts.createdAt,
  });
}

async function seedAppeal(id: string, targetJudge: string, createdAt: Date): Promise<void> {
  await writeEvent(testDb(), {
    id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:appeal_request',
    subject_kind: 'event',
    subject_id: targetJudge,
    outcome: null,
    payload: { reason_md: '判错了' },
    created_at: createdAt,
  });
}

beforeEach(async () => {
  await resetDb();
});

describe('assessment-verdict — candidate order determinism on real Postgres (YUK-1106)', () => {
  it('reverse physical insertion (j_new row lands BEFORE j_old; j_old created_at earlier) still reports j_old chain provenance', async () => {
    await seedAttempt('att_rev');
    // 物理插入序刻意倒置：新判先落库，旧判最后落库但 created_at 更早（T1<T2）。
    await seedAppeal('appeal_rev', 'j_old_rev', T2);
    await seedJudge({
      id: 'j_new_rev',
      attemptEventId: 'att_rev',
      causedBy: 'appeal_rev',
      coarseOutcome: 'correct',
      score: 0.95,
      actorRef: 'rejudge',
      appealEventId: 'appeal_rev',
      createdAt: T2,
    });
    await seedJudge({
      id: 'j_old_rev',
      attemptEventId: 'att_rev',
      coarseOutcome: 'incorrect',
      score: 0.1,
      createdAt: T1,
    });
    await seedCorrection({
      id: 'corr_rev',
      targetEventId: 'j_old_rev',
      correctionKind: 'supersede',
      replacementEventId: 'j_new_rev',
      causedBy: 'j_new_rev',
      createdAt: T2,
    });

    const v = (await resolveVerdictsForAttempts(testDb(), ['att_rev'])).get('att_rev');
    expect(v?.original?.judge_event_id).toBe('j_old_rev');
    expect(v?.original?.correction_state.state).toBe('superseded');
    expect(v?.effective?.judge_event_id).toBe('j_new_rev');
    // YUK-1106 核心：effective 的链来源是 j_old_rev，与候选返回顺序无关。
    expect(v?.effective?.original_event_id).toBe('j_old_rev');
    expect(v?.newest_raw?.judge_event_id).toBe('j_new_rev');
  });

  it('multi-hop chain j1→j2→j3: effective row is j3 while provenance is the chain ROOT j1 (not the middle hop)', async () => {
    await seedAttempt('att_multi');
    await seedJudge({
      id: 'j1',
      attemptEventId: 'att_multi',
      coarseOutcome: 'incorrect',
      createdAt: T1,
    });
    await seedJudge({
      id: 'j2',
      attemptEventId: 'att_multi',
      causedBy: 'appeal_m1',
      coarseOutcome: 'partial',
      createdAt: T2,
    });
    await seedJudge({
      id: 'j3',
      attemptEventId: 'att_multi',
      causedBy: 'appeal_m2',
      coarseOutcome: 'correct',
      createdAt: T3,
    });
    await seedAppeal('appeal_m1', 'j1', T2);
    await seedAppeal('appeal_m2', 'j2', T3);
    await seedCorrection({
      id: 'corr_m1',
      targetEventId: 'j1',
      correctionKind: 'supersede',
      replacementEventId: 'j2',
      causedBy: 'j2',
      createdAt: T2,
    });
    await seedCorrection({
      id: 'corr_m2',
      targetEventId: 'j2',
      correctionKind: 'supersede',
      replacementEventId: 'j3',
      causedBy: 'j3',
      createdAt: T3,
    });

    const v = (await resolveVerdictsForAttempts(testDb(), ['att_multi'])).get('att_multi');
    expect(v?.original?.judge_event_id).toBe('j1');
    expect(v?.original?.correction_state.state).toBe('superseded');
    // effective = 链端 j3；链来源 = 最早链根 j1（不是中间跳 j2 的链）。
    expect(v?.effective?.judge_event_id).toBe('j3');
    expect(v?.effective?.original_event_id).toBe('j1');
    expect(v?.effective?.correction_state.original_event_id).toBe('j1');
    expect(v?.effective?.correction_state.terminal_state).toBe('active');
    expect(v?.newest_raw?.judge_event_id).toBe('j3');
  });

  it('independent concurrent judges (no supersede relation): effective is the newest row with its OWN provenance — no fabricated rejudge source', async () => {
    await seedAttempt('att_indep');
    await seedJudge({
      id: 'j_a',
      attemptEventId: 'att_indep',
      actorRef: 'paper_judge',
      coarseOutcome: 'incorrect',
      createdAt: T1,
    });
    // 独立归因判：同一 attempt 的另一条 active 链，无 correction 关系。
    await seedJudge({
      id: 'j_b',
      attemptEventId: 'att_indep',
      actorRef: 'attribution',
      coarseOutcome: 'incorrect',
      createdAt: T2,
    });

    const v = (await resolveVerdictsForAttempts(testDb(), ['att_indep'])).get('att_indep');
    // original = 最早的 j_a；effective/newest_raw = 最新的 j_b，链来源是 j_b
    // 自己（独立判不继承别人的链——不得因顺序稳定化而伪造 supersede 语义）。
    expect(v?.original?.judge_event_id).toBe('j_a');
    expect(v?.original?.correction_state.state).toBe('active');
    expect(v?.effective?.judge_event_id).toBe('j_b');
    expect(v?.effective?.original_event_id).toBe('j_b');
    expect(v?.effective?.correction_state.terminal_state).toBe('active');
    expect(v?.newest_raw?.judge_event_id).toBe('j_b');
  });

  it('tie-break at equal created_at + dispatch_seq: id decides newest/effective; original takes the smaller id', async () => {
    await seedAttempt('att_tie');
    // 同一毫秒、同一 dispatch_seq —— 规范比较器退到 id 字典序。
    await seedJudge({
      id: 'j_tie_a',
      attemptEventId: 'att_tie',
      coarseOutcome: 'incorrect',
      createdAt: T1,
    });
    await seedJudge({
      id: 'j_tie_b',
      attemptEventId: 'att_tie',
      coarseOutcome: 'correct',
      createdAt: T1,
    });

    const v = (await resolveVerdictsForAttempts(testDb(), ['att_tie'])).get('att_tie');
    expect(v?.original?.judge_event_id).toBe('j_tie_a');
    expect(v?.effective?.judge_event_id).toBe('j_tie_b');
    expect(v?.effective?.original_event_id).toBe('j_tie_b');
    expect(v?.newest_raw?.judge_event_id).toBe('j_tie_b');
  });
});
