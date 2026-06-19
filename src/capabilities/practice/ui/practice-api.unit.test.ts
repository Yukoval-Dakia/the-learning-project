// YUK-433 — computeLatencyMs 纯逻辑单测（solo 路径 RT capture 复活）。
//
// A1（YUK-433）PR1：救活 TanStack SPA solo 复习路径里休眠的 response-time capture——
// 服务端 submit schema 早已接受 latency_ms（src/capabilities/practice/api/submit.ts:72）并把它
// 映射成事件 payload 的 duration_ms（同文件 :531），但 SPA 从未发送（旧 Next.js worktree 的
// questionShownAt 计时器没被搬过来）。computeLatencyMs 是 commit 时计算「这次作答用了多久」的
// 唯一纯函数，必须把 clamp 边界逐字对齐服务端 zod 约束 [0, 3_600_000]。
//
// No-DB unit partition（不 import db/postgres/drizzle）；纯函数，无 DOM 依赖。

import { describe, expect, it } from 'vitest';
import { buildDraftListQuery, computeLatencyMs } from './practice-api';

describe('computeLatencyMs — solo 路径 RT capture (YUK-433)', () => {
  it('shownAt 为 null → 返回 null（计时器未起 / 题面未就绪，不发噪声）', () => {
    expect(computeLatencyMs(null, 1_000)).toBe(null);
  });

  it('正常用例 → now - shownAt（毫秒墙钟差）', () => {
    expect(computeLatencyMs(1_000, 6_000)).toBe(5_000);
  });

  it('连续两次正常调用 → 各自独立算差（commit 间 stamp 不被复用）', () => {
    expect(computeLatencyMs(1_000, 6_000)).toBe(5_000);
    expect(computeLatencyMs(2_000, 9_000)).toBe(7_000);
  });

  it('负差 / 时钟回拨 → clamp 到 0（下界对齐 server zod .min(0)）', () => {
    // now < shownAt（系统时钟回拨）：不应发负值，clamp 到 0。
    expect(computeLatencyMs(6_000, 1_000)).toBe(0);
  });

  it('超过 1 小时 → clamp 到 3_600_000（上界对齐 server zod .max(3_600_000)）', () => {
    // 标签页挂置一整天等极端墙钟差：clamp 到服务端上界，避免 422。
    expect(computeLatencyMs(0, 10_000_000)).toBe(3_600_000);
  });

  it('恰好 1 小时上界 → 不被 clamp（边界包含）', () => {
    expect(computeLatencyMs(0, 3_600_000)).toBe(3_600_000);
  });

  it('恰好 0 下界 → 不被 clamp（now === shownAt，瞬时提交）', () => {
    expect(computeLatencyMs(5_000, 5_000)).toBe(0);
  });
});

describe('buildDraftListQuery — getDrafts 负值防御 (YUK-408)', () => {
  it('正常正值 → 原样透传（current caller limit: 200 不受影响）', () => {
    expect(buildDraftListQuery({ limit: 200, offset: 0 })).toBe('limit=200&offset=0');
  });

  it('负 limit → 丢弃（不发 ?limit=-5；服务端落自身 default）', () => {
    expect(buildDraftListQuery({ limit: -5 })).toBe('');
  });

  it('零 limit → 丢弃（≤0 无意义）', () => {
    expect(buildDraftListQuery({ limit: 0 })).toBe('');
  });

  it('负 offset → 丢弃（offset 是非负索引）', () => {
    expect(buildDraftListQuery({ offset: -10 })).toBe('');
  });

  it('offset=0 → 保留（0 是合法下界）', () => {
    expect(buildDraftListQuery({ offset: 0 })).toBe('offset=0');
  });

  it('非整数 limit/offset → 截断为整（不发小数）', () => {
    expect(buildDraftListQuery({ limit: 50.9, offset: 3.2 })).toBe('limit=50&offset=3');
  });

  it('非有限值（NaN / Infinity）→ 丢弃', () => {
    expect(buildDraftListQuery({ limit: Number.NaN, offset: Number.POSITIVE_INFINITY })).toBe('');
  });

  it('source / kind 过滤保留，负 limit 仍被丢', () => {
    expect(buildDraftListQuery({ source: 'import', kind: 'mcq', limit: -1 })).toBe(
      'source=import&kind=mcq',
    );
  });
});
