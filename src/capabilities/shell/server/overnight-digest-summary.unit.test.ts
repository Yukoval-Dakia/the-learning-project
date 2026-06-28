// YUK-520 (A1) — overnight-digest 纯判定逻辑 unit 测（no-DB 车道，约定 glob
// src/capabilities/**/*.unit.test.ts）。覆盖三块纯函数：窗口边界算（BJT 前一日历日 + 边界瞬时）、
// runs 分组、has_overnight_activity 五源组合（红线②空夜显式信号的执行机制）。
import { describe, expect, it } from 'vitest';
import {
  type RunStatusCountRow,
  groupRunsByKind,
  hasOvernightActivity,
  overnightWindow,
} from './overnight-digest-summary';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('overnightWindow — BJT 前一日历日窗口', () => {
  it('窗口 = 昨日 00:00 BJT (含) → 今日 00:00 BJT (不含)，跨度恰 24h', () => {
    // now = 2026-06-28T10:00Z → BJT 18:00 06-28 → 今日 00:00 BJT = 06-27T16:00Z
    const { from, to } = overnightWindow(new Date('2026-06-28T10:00:00Z'));
    expect(from.toISOString()).toBe('2026-06-26T16:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-27T16:00:00.000Z');
    expect(to.getTime() - from.getTime()).toBe(DAY_MS);
  });

  it('刚过 BJT 午夜 (16:00Z)：窗口推进到前一 BJT 日', () => {
    // now = 2026-06-28T16:30Z → BJT 00:30 06-29 → 今日 00:00 BJT = 06-28T16:00Z
    const { from, to } = overnightWindow(new Date('2026-06-28T16:30:00Z'));
    expect(from.toISOString()).toBe('2026-06-27T16:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-28T16:00:00.000Z');
  });

  it('刚过 BJT 午夜前 (15:30Z)：仍在前一 BJT 日窗口（口径无漂移）', () => {
    // now = 2026-06-28T15:30Z → BJT 23:30 06-28 → 今日 00:00 BJT = 06-27T16:00Z
    const { from, to } = overnightWindow(new Date('2026-06-28T15:30:00Z'));
    expect(from.toISOString()).toBe('2026-06-26T16:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-27T16:00:00.000Z');
  });

  it('跨月边界正确（BJT 月初）', () => {
    // now = 2026-07-01T02:00Z → BJT 10:00 07-01 → 今日 00:00 BJT = 06-30T16:00Z
    const { from, to } = overnightWindow(new Date('2026-07-01T02:00:00Z'));
    expect(from.toISOString()).toBe('2026-06-29T16:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-30T16:00:00.000Z');
  });
});

describe('groupRunsByKind — ai_task_runs 按 kind 卷起', () => {
  it('空输入 → []', () => {
    expect(groupRunsByKind([])).toEqual([]);
  });

  it('按 task_kind 求和 count + 建 status_breakdown，task_kind 升序', () => {
    const rows: RunStatusCountRow[] = [
      { task_kind: 'note_refine', status: 'success', count: 2 },
      { task_kind: 'note_refine', status: 'error', count: 1 },
      { task_kind: 'dreaming', status: 'success', count: 3 },
    ];
    const out = groupRunsByKind(rows);
    expect(out.map((g) => g.task_kind)).toEqual(['dreaming', 'note_refine']);
    const noteRefine = out.find((g) => g.task_kind === 'note_refine');
    expect(noteRefine?.count).toBe(3);
    expect(noteRefine?.status_breakdown).toEqual({ success: 2, error: 1 });
    const dreaming = out.find((g) => g.task_kind === 'dreaming');
    expect(dreaming?.count).toBe(3);
    expect(dreaming?.status_breakdown).toEqual({ success: 3 });
  });
});

describe('hasOvernightActivity — 五源显式组合（空夜一等态）', () => {
  const ZERO = {
    runs_total: 0,
    note_changes_count: 0,
    new_proposals_count: 0,
    new_conjectures_count: 0,
    agent_notes_count: 0,
  };

  it('五源全 0 → false（空夜显式信号，非缺省 falsy）', () => {
    expect(hasOvernightActivity(ZERO)).toBe(false);
  });

  it('任一源 > 0 → true（逐源覆盖，防漏算某一源）', () => {
    expect(hasOvernightActivity({ ...ZERO, runs_total: 1 })).toBe(true);
    expect(hasOvernightActivity({ ...ZERO, note_changes_count: 1 })).toBe(true);
    expect(hasOvernightActivity({ ...ZERO, new_proposals_count: 1 })).toBe(true);
    expect(hasOvernightActivity({ ...ZERO, new_conjectures_count: 1 })).toBe(true);
    expect(hasOvernightActivity({ ...ZERO, agent_notes_count: 1 })).toBe(true);
  });
});
