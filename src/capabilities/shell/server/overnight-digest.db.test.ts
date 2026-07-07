// YUK-520 (A1) — overnight-digest 读模型 db 测（DB 装配端到端）。纯函数边界覆盖（窗口算 /
// runs 分组 / has_overnight_activity 五源）在 no-DB unit 车道（overnight-digest-summary.unit.test.ts）。
// 本文件证：五个夜间事实源各自被窗口正确收/排，proposals 与 conjectures 不重叠，空夜显式信号。
//
// 注入 now 让窗口确定性：overnightWindow(NOW) = [2026-06-26T16:00Z, 2026-06-27T16:00Z)（BJT 前一日历日）。
import { ai_task_runs, event } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadOvernightDigest } from './overnight-digest';

const db = testDb();

// NOW 注入 → 窗口 [from, to)：BJT 前一日历日。
const NOW = new Date('2026-06-28T08:00:00Z');
const IN_WINDOW = new Date('2026-06-26T17:00:00Z'); // from + 1h（窗内）
const BEFORE_WINDOW = new Date('2026-06-26T15:00:00Z'); // from - 1h（窗前）
const AFTER_WINDOW = new Date('2026-06-27T17:00:00Z'); // to + 1h（今日，窗后）

let seq = 0;

async function seedEvent(opts: {
  action: string;
  subject_kind: string;
  subject_id?: string;
  payload?: Record<string, unknown>;
  created_at: Date;
}): Promise<void> {
  seq += 1;
  await db.insert(event).values({
    id: `ev_${seq}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'test',
    action: opts.action,
    subject_kind: opts.subject_kind,
    subject_id: opts.subject_id ?? `subj_${seq}`,
    outcome: null,
    payload: opts.payload ?? {},
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at,
  });
}

async function seedRun(opts: {
  task_kind: string;
  status: string;
  finished_at: Date | null;
  error_message?: string | null;
  finish_reason?: string | null;
}): Promise<void> {
  seq += 1;
  await db.insert(ai_task_runs).values({
    id: `run_${seq}`,
    task_kind: opts.task_kind,
    provider: 'test',
    model: 'test-model',
    input_hash: `h_${seq}`,
    status: opts.status,
    started_at: IN_WINDOW,
    finished_at: opts.finished_at,
    error_message: opts.error_message ?? null,
    finish_reason: opts.finish_reason ?? null,
  });
}

describe('loadOvernightDigest read model', () => {
  beforeEach(async () => {
    await resetDb();
    seq = 0;
  });

  it('安静夜：零事实 → has_overnight_activity=false + 全零计数 + 窗口存在', async () => {
    const d = await loadOvernightDigest(db, NOW);
    expect(d.has_overnight_activity).toBe(false);
    expect(d.runs).toEqual([]);
    expect(d.note_changes_count).toBe(0);
    expect(d.new_proposals_count).toBe(0);
    expect(d.new_conjectures_count).toBe(0);
    expect(d.agent_notes_count).toBe(0);
    expect(d.degraded_kinds).toEqual([]);
    expect(d.window.from).toBe('2026-06-26T16:00:00.000Z');
    expect(d.window.to).toBe('2026-06-27T16:00:00.000Z');
  });

  it('ai_task_runs：按 finished_at 窗内聚合，排除窗外 + 未完成(null finished_at)', async () => {
    await seedRun({ task_kind: 'note_refine', status: 'success', finished_at: IN_WINDOW });
    // YUK-576：seed 用真实生产词表（status='failure'，finish_reason 细分）——
    // 'error' 从来不是任何 writer 写的 status 值（log.ts 封闭枚举）。
    await seedRun({
      task_kind: 'note_refine',
      status: 'failure',
      finish_reason: 'error',
      finished_at: IN_WINDOW,
    });
    await seedRun({ task_kind: 'dreaming', status: 'success', finished_at: IN_WINDOW });
    await seedRun({ task_kind: 'dreaming', status: 'success', finished_at: AFTER_WINDOW }); // 窗后
    await seedRun({ task_kind: 'dreaming', status: 'running', finished_at: null }); // 未完成

    const d = await loadOvernightDigest(db, NOW);
    expect(d.has_overnight_activity).toBe(true);
    const byKind = new Map(d.runs.map((g) => [g.task_kind, g]));
    expect(byKind.get('note_refine')?.count).toBe(2);
    expect(byKind.get('note_refine')?.status_breakdown).toEqual({ success: 1, failure: 1 });
    // 窗后 + 未完成的 dreaming 都被排除 → 窗内仅 1
    expect(byKind.get('dreaming')?.count).toBe(1);
    expect(byKind.get('dreaming')?.status_breakdown).toEqual({ success: 1 });
    // note_refine 窗内仅 1 次 error（< DEGRADED_KIND_ERROR_THRESHOLD=2）→ 不标红
    expect(d.degraded_kinds).toEqual([]);
  });

  describe('degraded_kinds（YUK-580）：静默失败标红', () => {
    it('某 kind 窗内连续 error 计数达阈值 → 标红 + 回带最近 N 条 error_message（新→旧）', async () => {
      await seedRun({
        task_kind: 'note_refine',
        status: 'failure',
        finish_reason: 'error',
        finished_at: IN_WINDOW,
        error_message: 'boom-1',
      });
      await seedRun({
        task_kind: 'note_refine',
        status: 'failure',
        finish_reason: 'error',
        finished_at: new Date(IN_WINDOW.getTime() + 1000),
        error_message: 'boom-2',
      });
      await seedRun({
        task_kind: 'note_refine',
        status: 'failure',
        finish_reason: 'error',
        finished_at: new Date(IN_WINDOW.getTime() + 2000),
        error_message: 'boom-3',
      });
      await seedRun({
        task_kind: 'note_refine',
        status: 'failure',
        finish_reason: 'error',
        finished_at: new Date(IN_WINDOW.getTime() + 3000),
        error_message: 'boom-4',
      });
      // 混一条 success，不应干扰 error 计数
      await seedRun({ task_kind: 'note_refine', status: 'success', finished_at: IN_WINDOW });

      const d = await loadOvernightDigest(db, NOW);
      expect(d.degraded_kinds).toHaveLength(1);
      const dk = d.degraded_kinds[0];
      expect(dk.task_kind).toBe('note_refine');
      expect(dk.error_count).toBe(4);
      // 最近 3 条（N=DEGRADED_KIND_SAMPLE_SIZE），新→旧
      expect(dk.recent_error_messages).toEqual(['boom-4', 'boom-3', 'boom-2']);
    });

    it('低于阈值（1 次 error）→ 不标红', async () => {
      await seedRun({
        task_kind: 'dreaming',
        status: 'failure',
        finish_reason: 'error',
        finished_at: IN_WINDOW,
        error_message: 'single-boom',
      });
      const d = await loadOvernightDigest(db, NOW);
      expect(d.degraded_kinds).toEqual([]);
    });

    it('窗外的 error 不算入计数（BEFORE_WINDOW/AFTER_WINDOW 各 2 次不达标）', async () => {
      await seedRun({
        task_kind: 'dreaming',
        status: 'failure',
        finish_reason: 'error',
        finished_at: BEFORE_WINDOW,
        error_message: 'before-1',
      });
      await seedRun({
        task_kind: 'dreaming',
        status: 'failure',
        finish_reason: 'error',
        finished_at: BEFORE_WINDOW,
        error_message: 'before-2',
      });
      await seedRun({
        task_kind: 'dreaming',
        status: 'failure',
        finish_reason: 'error',
        finished_at: AFTER_WINDOW,
        error_message: 'after-1',
      });
      await seedRun({
        task_kind: 'dreaming',
        status: 'failure',
        finish_reason: 'error',
        finished_at: AFTER_WINDOW,
        error_message: 'after-2',
      });
      const d = await loadOvernightDigest(db, NOW);
      expect(d.degraded_kinds).toEqual([]);
    });

    it('error_message 超长截断生效', async () => {
      const long = 'x'.repeat(500);
      await seedRun({
        task_kind: 'dreaming',
        status: 'failure',
        finish_reason: 'error',
        finished_at: IN_WINDOW,
        error_message: long,
      });
      await seedRun({
        task_kind: 'dreaming',
        status: 'failure',
        finish_reason: 'error',
        finished_at: new Date(IN_WINDOW.getTime() + 1000),
        error_message: long,
      });
      const d = await loadOvernightDigest(db, NOW);
      expect(d.degraded_kinds).toHaveLength(1);
      const [msg] = d.degraded_kinds[0].recent_error_messages;
      expect(msg.length).toBeLessThan(long.length);
      expect(msg.endsWith('…')).toBe(true);
    });

    // ── YUK-576 §5.3 — watchdog 死过滤修复（status 'error' → 'failure'）────────
    // 生产封闭写入词表 = {running, success, failure}（log.ts:124），零 writer 写
    // 'error' —— 旧过滤对真实失败全盲。修复后按 status='failure' 收，且排除两类
    // 非「逻辑失败」行：'error_retried'（重试非末次，runner §3.3）与
    // 'reconciled_stuck'（sweeper 收敛行，§5.2）。alerting 面排除、翻查面保留。
    describe('YUK-576：真实失败词表（failure）+ 非逻辑失败排除', () => {
      it("status='failure' + finish_reason='error' 达阈值 → 标红（旧 'error' 过滤收不到 = RED）", async () => {
        await seedRun({
          task_kind: 'steps_judge',
          status: 'failure',
          finish_reason: 'error',
          finished_at: IN_WINDOW,
          error_message: 'real-fail-1',
        });
        await seedRun({
          task_kind: 'steps_judge',
          status: 'failure',
          finish_reason: 'error',
          finished_at: new Date(IN_WINDOW.getTime() + 1000),
          error_message: 'real-fail-2',
        });

        const d = await loadOvernightDigest(db, NOW);
        expect(d.degraded_kinds).toHaveLength(1);
        expect(d.degraded_kinds[0].task_kind).toBe('steps_judge');
        expect(d.degraded_kinds[0].error_count).toBe(2);
        expect(d.degraded_kinds[0].recent_error_messages).toEqual(['real-fail-2', 'real-fail-1']);
      });

      it("'error_retried'（重试非末次）不计入 —— 一次逻辑请求两跳全挂只计 1，不打满阈值", async () => {
        // 同一逻辑请求：attempt-1 error_retried + attempt-2 error → 只计末级 1 条。
        await seedRun({
          task_kind: 'steps_judge',
          status: 'failure',
          finish_reason: 'error_retried',
          finished_at: IN_WINDOW,
          error_message: 'attempt-1',
        });
        await seedRun({
          task_kind: 'steps_judge',
          status: 'failure',
          finish_reason: 'error',
          finished_at: new Date(IN_WINDOW.getTime() + 1000),
          error_message: 'attempt-2-final',
        });

        const d = await loadOvernightDigest(db, NOW);
        // 计 1 < DEGRADED_KIND_ERROR_THRESHOLD(2) → 不标红。
        expect(d.degraded_kinds).toEqual([]);
      });

      it("'reconciled_stuck'（sweeper 收敛行）不计入告警", async () => {
        await seedRun({
          task_kind: 'note_generate',
          status: 'failure',
          finish_reason: 'reconciled_stuck',
          finished_at: IN_WINDOW,
          error_message: 'reconciled by stuck-run sweeper',
        });
        await seedRun({
          task_kind: 'note_generate',
          status: 'failure',
          finish_reason: 'reconciled_stuck',
          finished_at: new Date(IN_WINDOW.getTime() + 1000),
          error_message: 'reconciled by stuck-run sweeper',
        });

        const d = await loadOvernightDigest(db, NOW);
        expect(d.degraded_kinds).toEqual([]);
      });
    });
  });

  it('note refine changes：窗内 count，排除窗前 + 窗后', async () => {
    const note = (created_at: Date) =>
      seedEvent({
        action: 'experimental:note_refine_apply',
        subject_kind: 'artifact',
        payload: {
          ops_count: 1,
          new_blocks: 0,
          previous_artifact_version: 0,
          next_artifact_version: 1,
        },
        created_at,
      });
    await note(IN_WINDOW);
    await note(BEFORE_WINDOW);
    await note(AFTER_WINDOW);

    const d = await loadOvernightDigest(db, NOW);
    expect(d.note_changes_count).toBe(1);
  });

  it('agent notes：窗内新 experimental:agent_note count', async () => {
    const note = (created_at: Date) =>
      seedEvent({
        action: 'experimental:agent_note',
        subject_kind: 'query',
        payload: { target_agents: ['dreaming'], summary_md: 'x', signal_kind: 'hint' },
        created_at,
      });
    await note(IN_WINDOW);
    await note(IN_WINDOW);
    await note(AFTER_WINDOW); // 窗后

    const d = await loadOvernightDigest(db, NOW);
    expect(d.agent_notes_count).toBe(2);
  });

  it('proposals vs conjectures：不重叠（new_proposals = 全部 − conjecture 子集）', async () => {
    // 2 条普通 knowledge 提议（窗内）
    await seedEvent({ action: 'propose', subject_kind: 'knowledge', created_at: IN_WINDOW });
    await seedEvent({ action: 'propose', subject_kind: 'knowledge', created_at: IN_WINDOW });
    // 1 条 conjecture（experimental:proposal + payload.ai_proposal.kind=conjecture，窗内）
    await seedEvent({
      action: 'experimental:proposal',
      subject_kind: 'mind_model',
      payload: { ai_proposal: { kind: 'conjecture', claim_md: 'x' } },
      created_at: IN_WINDOW,
    });
    // 窗后的提议不计
    await seedEvent({ action: 'propose', subject_kind: 'knowledge', created_at: AFTER_WINDOW });

    const d = await loadOvernightDigest(db, NOW);
    // total=3 (2 propose + 1 conjecture), conjectures=1 → new_proposals=2, new_conjectures=1
    expect(d.new_proposals_count).toBe(2);
    expect(d.new_conjectures_count).toBe(1);
    expect(d.has_overnight_activity).toBe(true);
  });
});
