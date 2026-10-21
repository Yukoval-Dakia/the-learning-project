// CoachTask contract. The model-facing shape is `CoachPlanDraft` (prose +
// proposals + attention tags); the persisted TodayPlan numbers are composed by
// the job from the due queue + daily budget. This strict parseText is the owned
// contract; coach_daily / coach_weekly handlers keep their own best-effort parse
// for live-model prose wrapping.
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';

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
    // 纯文本推理，无 vision 需求；mimo-v2.5 (multimodal) 作为 fallback 保留。
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 12, timeout: 120_000 },
    needsToolCall: true,
    isMultimodal: false,
    // coach_daily / coach_weekly handlers supply the surface-specific DomainTool
    // allowlist from src/kernel/tools/allowlists.ts; registry default stays empty.
    allowedTools: [],
    prompt: {
      kind: 'inline',
      text: '你是 Coach agent。读取 DomainTools 给出的学习信号，产出今日安排草稿 JSON，所有 mutation 走 propose_* 工具写入 inbox。不要直接改用户数据；不要估算题数、分钟数或科目配比——这些由系统按到期队列和每日预算计算。没有高价值建议时输出空 plan_adjustments / maintenance_proposals。',
    },
  },
  outputSchema: CoachPlanDraft,
  parseText: parseCoachTaskOutput,
} satisfies TaskSpec<unknown, CoachPlanDraftT>;
