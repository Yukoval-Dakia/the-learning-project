// YUK-432 — PfSolo 客观题判别（auto-commit gate）的纯逻辑单测。
//
// PfSolo 没有 render 测试 harness（项目不带 jsdom/testing-library），且引入它属 scope creep。
// 自动判分/自动评级的**判定**逻辑被抽成纯谓词 isObjectiveQuestion(route)，它就是
// runJudge 里「preview 回来后是否自动 commit(auto_rate:true)」的唯一开关。
//
// 关键不变式（YUK-432 firm-up unblock，Bugbot Medium 修复）：UI auto-rate gate 必须**逐字**对齐
// 后端 label gate。后端（src/server/mastery/personalized-difficulty.ts 的 isObjectiveJudgeRoute）
// 仅在判分 ROUTE ∈ {exact, keyword} 时才写 difficulty_calibration_label，键于 judge route，
// 与题型（kind）无关。因此 UI 也必须**只**看 route：
//   - 客观判分路由（exact/keyword）→ 自动 commit(auto_rate:true)，跳过手动评级（后端会写 label）。
//   - 其它路由（semantic/rubric/steps…）→ 落现有手动 again/hard/good 流（后端不写 label）。
// 旧实现额外用 kind-OR 兜底（choice/true_false/fill_blank 也算客观），这会让一道**题型客观但
// 判分路由非客观**（例如 judge_kind_override=semantic 路由到 semantic 的 choice 题）在 UI 侧过 gate
// → auto_rate:true 自动 commit、跳过手动评级 —— 但后端 route gate 为 false → **不写 label**。
// 用户走完自动流，B1 label 却从未落库，且一道被语义判分的题被错误地跳过了手动评级。修复=去掉
// kind-OR，UI gate ≡ 后端 isObjectiveJudgeRoute（route only）。
//
// 端到端写库证据在 submit.db.test.ts「YUK-432 — 客观 auto_rate 产 difficulty_calibration_label」。
//
// No-DB unit partition（不 import db/postgres/drizzle）；node env 下 PfSolo.tsx 导入干净（无 DOM 调用）。

import { describe, expect, it } from 'vitest';
import { appealEntryAvailable, isObjectiveQuestion, shouldMarkSlotDoneOnBack } from './PfSolo';

describe('isObjectiveQuestion — PfSolo 客观题 auto-commit gate (YUK-432)', () => {
  it('(a) choice/true_false 题（route exact）→ 客观（auto-rate）', () => {
    // 正常封闭客观题的判分路由本就是确定性的 exact → 自动判分+自动评级，后端也会写 label。
    expect(isObjectiveQuestion('exact')).toBe(true);
  });

  it('(b) fill_blank 题（route keyword）→ 客观（auto-rate）', () => {
    // fill_blank（带 reference）路由到 exact/keyword → 客观，后端写 label。
    expect(isObjectiveQuestion('keyword')).toBe(true);
  });

  it('(c) BUGBOT 回归：题型客观但 route=semantic（judge_kind_override）→ 非客观（保留手动评级）', () => {
    // 一道 choice/true_false/fill_blank 携带 judge_kind_override=semantic、路由到 semantic：
    // 旧的 kind-OR 兜底会判它为客观 → UI 发 auto_rate:true → 自动 commit、跳过手动评级，
    // 但后端 isObjectiveJudgeRoute('semantic')=false → **不写 label** → mismatch（auto-rate
    // 无 label）。修复后 UI gate 只看 route：semantic → 非客观 → 保留手动评级流，与后端一致。
    expect(isObjectiveQuestion('semantic')).toBe(false);
  });

  it('(d) 开放题（route semantic）→ 非客观 → 维持手动评级流', () => {
    // LLM-backed 主观判分 → 不自动 commit，落手动 again/hard/good。
    expect(isObjectiveQuestion('semantic')).toBe(false);
  });

  it('开放判分路由（rubric / steps）→ 非客观', () => {
    expect(isObjectiveQuestion('rubric')).toBe(false);
    expect(isObjectiveQuestion('steps')).toBe(false);
  });

  it('UI gate ≡ 后端 isObjectiveJudgeRoute：仅 route ∈ {exact, keyword} 为客观', () => {
    // 与 src/server/mastery/personalized-difficulty.ts 的 OBJECTIVE_JUDGE_ROUTES 逐字同源。
    for (const route of ['exact', 'keyword']) {
      expect(isObjectiveQuestion(route)).toBe(true);
    }
    for (const route of ['semantic', 'rubric', 'steps', 'advice', 'unsupported', 'reading']) {
      expect(isObjectiveQuestion(route)).toBe(false);
    }
  });
});

// FINDING 1（slot 不再卡 in_progress）— 客观题自动 commit 后 review 已落库，该 slot 实质 done。
// 「下一项」走 onDone（host completeSolo → PATCH done）；「返回流」必须经 shouldMarkSlotDoneOnBack
// 判定，autoCommitted 时走 onCommittedBack（host markSoloDoneAndExit → PATCH done），不再只 onBack
// 留下 in_progress。两条出口都让 auto-commit 后的 slot 落到一致的 done 态。
describe('shouldMarkSlotDoneOnBack — 自动 commit 后「返回流」也标 slot done (YUK-432 FINDING 1)', () => {
  it('自动 commit 后（autoCommitted=true）→「返回流」必须标 slot done', () => {
    // review 已落库 → 退出回流走 onCommittedBack（PATCH done），消除卡 in_progress 的 slot。
    expect(shouldMarkSlotDoneOnBack(true)).toBe(true);
  });

  it('未自动 commit（autoCommitted=false）→「返回流」保持原 onBack，slot 留 in_progress 供 resume', () => {
    // 作答中 / 开放题手动流：review 未提交，slot 应留 in_progress（半成品可继续），不能误标 done。
    expect(shouldMarkSlotDoneOnBack(false)).toBe(false);
  });

  it('不变式：「下一项」(onDone→PATCH done) 与「返回流」(autoCommitted→PATCH done) 收敛到同一 done 态', () => {
    // 「下一项」永远标 done（host completeSolo）；「返回流」在 autoCommitted 时也标 done。故自动 commit
    // 后两条出口都不会留下卡 in_progress 的 slot。
    const nextItemMarksDone = true; // onDone → completeSolo → advanceStreamItem(id, 'done')
    const backMarksDone = shouldMarkSlotDoneOnBack(true); // onCommittedBack → markSoloDoneAndExit
    expect(nextItemMarksDone).toBe(true);
    expect(backMarksDone).toBe(true);
  });
});

// FINDING 2（客观流不再吞申诉 + judge_event_id）— 客观题自动 commit 同样落了独立 judge 锚点 event
// （后端 submit.ts:550 在 judge_route ∈ JudgeKind {exact,keyword,…} 时写，经响应 judge.judge_event_id
// 回传），故 deterministic 判定**可申诉**（exact-match 误拒等价答案是真实场景）。UI 捕获该 id 后，反馈
// 卡「不服判」入口在自动 commit 后**仍可用**——不再被 autoCommitted 隐藏。可用性由 appealEntryAvailable
// 统一判：自动流要求拿到锚点，手动流恒可见。
describe('appealEntryAvailable — 自动 commit 后保留「不服判」+ 捕获 judge_event_id (YUK-432 FINDING 2)', () => {
  it('自动 commit 后捕获到锚点 → 申诉入口仍可用（不被 autoCommitted 隐藏）', () => {
    // 客观判分（exact/keyword）落了 judge 锚点并回传 id；用户可对该 deterministic 判定申诉。
    expect(
      appealEntryAvailable({
        phase: 'feedback',
        appealOpen: false,
        autoCommitted: true,
        autoCommitJudgeEventId: 'judge-evt-1',
      }),
    ).toBe(true);
  });

  it('自动 commit 但无锚点（理论兜底）→ 申诉入口隐藏（无可申诉对象，hide 正确）', () => {
    // 若 deterministic submit 真没回传可申诉锚点，则只隐藏入口、不报假可用。exact/keyword 实际恒有。
    expect(
      appealEntryAvailable({
        phase: 'feedback',
        appealOpen: false,
        autoCommitted: true,
        autoCommitJudgeEventId: null,
      }),
    ).toBe(false);
  });

  it('手动流（开放题）→ 入口恒可见（锚点在提交申诉时随 commit 落库）', () => {
    // 既有行为不变：手动评级流的「不服判」一直可见，不依赖预捕获 id。
    expect(
      appealEntryAvailable({
        phase: 'feedback',
        appealOpen: false,
        autoCommitted: false,
        autoCommitJudgeEventId: null,
      }),
    ).toBe(true);
  });

  it('作答相位 / 申诉框已展开 → 入口不显示（两条流一致）', () => {
    // 还没判分（answering）没有判定可申诉；申诉框已展开则入口让位给表单。
    expect(
      appealEntryAvailable({
        phase: 'answering',
        appealOpen: false,
        autoCommitted: false,
        autoCommitJudgeEventId: null,
      }),
    ).toBe(false);
    expect(
      appealEntryAvailable({
        phase: 'feedback',
        appealOpen: true,
        autoCommitted: true,
        autoCommitJudgeEventId: 'judge-evt-1',
      }),
    ).toBe(false);
  });
});
