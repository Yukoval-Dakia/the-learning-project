// YUK-432 — PfSolo 客观题判别（auto-commit gate）的纯逻辑单测。
//
// PfSolo 没有 render 测试 harness（项目不带 jsdom/testing-library），且引入它属 scope creep。
// 自动判分/自动评级的**判定**逻辑被抽成纯谓词 isObjectiveQuestion(route, kind)，它就是
// runJudge 里「preview 回来后是否自动 commit(auto_rate:true)」的唯一开关：
//   - 客观（exact/keyword 路由，或 choice/true_false/fill_blank 题型）→ 自动 commit，跳过手动评级。
//   - 开放（语义/主观判分 + 开放题型）→ 落现有手动 again/hard/good 流。
// 端到端写库证据在 submit.db.test.ts「YUK-432 — 客观 auto_rate 产 difficulty_calibration_label」。
//
// No-DB unit partition（不 import db/postgres/drizzle）；node env 下 PfSolo.tsx 导入干净（无 DOM 调用）。

import { describe, expect, it } from 'vitest';
import { isObjectiveQuestion } from './PfSolo';

describe('isObjectiveQuestion — PfSolo 客观题 auto-commit gate (YUK-432)', () => {
  it('客观判分路由（exact）→ 客观（即便题型是开放 short_answer）', () => {
    // exact 路由是确定性字符串匹配（后端 OBJECTIVE_JUDGE_ROUTES 同源）→ 自动判分+自动评级。
    expect(isObjectiveQuestion('exact', 'short_answer')).toBe(true);
  });

  it('客观判分路由（keyword）→ 客观', () => {
    expect(isObjectiveQuestion('keyword', 'short_answer')).toBe(true);
  });

  it('封闭客观题型（choice）→ 客观（即便路由是 semantic）', () => {
    expect(isObjectiveQuestion('semantic', 'choice')).toBe(true);
  });

  it('封闭客观题型（true_false / fill_blank）→ 客观', () => {
    expect(isObjectiveQuestion('semantic', 'true_false')).toBe(true);
    expect(isObjectiveQuestion('semantic', 'fill_blank')).toBe(true);
  });

  it('开放题（semantic 路由 + short_answer 题型）→ 非客观 → 维持手动评级流', () => {
    // LLM-backed 主观判分 + 开放题型 → 不自动 commit，落手动 again/hard/good。
    expect(isObjectiveQuestion('semantic', 'short_answer')).toBe(false);
  });

  it('开放题（rubric / steps 路由 + reading 题型）→ 非客观', () => {
    expect(isObjectiveQuestion('rubric', 'reading')).toBe(false);
    expect(isObjectiveQuestion('steps', 'essay')).toBe(false);
  });

  it('题型未知（undefined）+ 非客观路由 → 非客观（保守落手动流）', () => {
    expect(isObjectiveQuestion('semantic', undefined)).toBe(false);
  });
});
