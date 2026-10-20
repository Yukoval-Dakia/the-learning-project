// YUK-879 — CoachTask contract, owned by the agency capability (Wave 5 / T-D6
// lineage). The model-facing shape is `CoachPlanDraft` (prose + proposals +
// attention tags); the persisted TodayPlan numbers are composed by the job from
// the due queue + daily budget (YUK-1622). The coach_daily / coach_weekly
// handlers keep their best-effort parseCoachOutputSafely degradation path for
// live-model prose wrapping — this strict parseText is the owned contract, not
// the handler's runtime seam.
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';

// Legacy quarry alias preserved verbatim inside the moved definitions.
const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

import { CoachPlanDraft, type CoachPlanDraftT } from '@/core/schema/coach';
import { parseTaskOutput } from './parse-output';

export function parseCoachTaskOutput(text: string): CoachPlanDraftT {
  return CoachPlanDraft.parse(parseTaskOutput(text, 'CoachTask', CoachPlanDraft));
}

export const coachTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'CoachTask',
    description:
      'Wave 5 / T-D6 — Phase 3 Global Coach Orchestrator. Reads via the `coach` DomainTool allowlist and outputs a `TodayPlan` draft consumed by the coach_daily / coach_weekly handlers. Count, minutes, time box and subject mix are computed server-side; the model supplies daily_focus, knowledge focus, intent tags and proposals. All mutations are routed through propose_* tools (zero direct DB writes).',
    defaultProvider: 'xiaomi',
    // CoachTask 纯文本推理（读 brief / event / proposal，输出 TodayPlan JSON）。
    // 无 vision 需求 → 走 mimo-v2.5-pro (text-only, 推理强) default，匹配 registry.ts
    // 其他非 vision task 的约定。mimo-v2.5 (multimodal) 作为 fallback 保留。
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 12, timeout: 120_000 },
    needsToolCall: true,
    isMultimodal: false,
    // The coach_daily / coach_weekly handlers supply the surface-specific
    // DomainTool allowlist from src/server/ai/tools/allowlists.ts so this
    // registry default stays empty for tests and non-handler callers.
    allowedTools: [],
    prompt: {
      kind: 'inline',
      text: '你是 Coach agent。读取 DomainTools 给出的学习信号，产出今日安排草稿 JSON，所有 mutation 走 propose_* 工具写入 inbox。不要直接改用户数据；不要估算题数、分钟数或科目配比——这些由系统按到期队列和每日预算计算。没有高价值建议时输出空 plan_adjustments / maintenance_proposals。',
    },
  },
  outputSchema: CoachPlanDraft,
  parseText: parseCoachTaskOutput,
} satisfies TaskSpec<unknown, CoachPlanDraftT>;
