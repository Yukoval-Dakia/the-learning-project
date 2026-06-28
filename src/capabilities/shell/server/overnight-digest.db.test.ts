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
    expect(d.window.from).toBe('2026-06-26T16:00:00.000Z');
    expect(d.window.to).toBe('2026-06-27T16:00:00.000Z');
  });

  it('ai_task_runs：按 finished_at 窗内聚合，排除窗外 + 未完成(null finished_at)', async () => {
    await seedRun({ task_kind: 'note_refine', status: 'success', finished_at: IN_WINDOW });
    await seedRun({ task_kind: 'note_refine', status: 'error', finished_at: IN_WINDOW });
    await seedRun({ task_kind: 'dreaming', status: 'success', finished_at: IN_WINDOW });
    await seedRun({ task_kind: 'dreaming', status: 'success', finished_at: AFTER_WINDOW }); // 窗后
    await seedRun({ task_kind: 'dreaming', status: 'running', finished_at: null }); // 未完成

    const d = await loadOvernightDigest(db, NOW);
    expect(d.has_overnight_activity).toBe(true);
    const byKind = new Map(d.runs.map((g) => [g.task_kind, g]));
    expect(byKind.get('note_refine')?.count).toBe(2);
    expect(byKind.get('note_refine')?.status_breakdown).toEqual({ success: 1, error: 1 });
    // 窗后 + 未完成的 dreaming 都被排除 → 窗内仅 1
    expect(byKind.get('dreaming')?.count).toBe(1);
    expect(byKind.get('dreaming')?.status_breakdown).toEqual({ success: 1 });
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
