// YUK-987 (985/E2) — SupplyPlanV1：供给 planner agent 产出的需求计划 artifact。
//
// 照 ADR-0038 quiz_gen_plan 范式：LLM 只做规划（要什么题、补哪个知识点、多少道、
// 偏好哪条获取路线），产出机器可检的 typed JSON；确定性机器门
// （src/capabilities/practice/server/question-supply/supply-plan-gate.ts）先验证
// （schema + 活 knowledge_id + 词表 + 去重 + 预算声明），通过后计划才生效，
// 拒绝则 ≤2 轮有界重生成，仍不过则 fail closed（当晚零派发）。
//
// route_preference 词表与 target-discovery.ts 的 SupplyRoute 是孪生词表（lock-step
// 双生先例照 SupplyProducerRoute）：core schema 不能反向 import server 侧模块，
// 词表值必须保持一致（'jyeoo_fetch' 仅作 trace/provenance 合法值保留，机器面已退役）。

import { z } from 'zod';
import { QuestionKind } from './business';

export const SUPPLY_PLAN_VERSION = 1 as const;

export const SUPPLY_PLAN_ROUTES = [
  'sourcing_web',
  'quiz_gen',
  'author_question',
  'ingest_existing',
  'image_candidate',
  'jyeoo_fetch',
] as const;

export type SupplyPlanRouteT = (typeof SUPPLY_PLAN_ROUTES)[number];

export const SupplyPlanItemV1 = z.object({
  // 知识图谱里真实存在且未归档的节点 id（机检回查，查无此点整份计划被拒）。
  knowledge_id: z.string().min(1),
  // canonical QuestionKind 之一，或 'any'（该格子任意题型可填）。
  kind: z.union([QuestionKind, z.literal('any')]),
  difficulty_band: z.enum(['below', 'near', 'above', 'stretch']),
  count: z.number().int().min(1).max(10),
  route_preference: z.array(z.enum(SUPPLY_PLAN_ROUTES)).min(1),
  // 需求理由（为什么这个格子值得补）——留痕与 shadow 分析用，不进正确性路径。
  rationale: z.string().min(1).max(500),
});

export const SupplyPlanV1 = z.object({
  version: z.literal(SUPPLY_PLAN_VERSION),
  // 空 items 合法：planner 判定今晚零需求是有效结论（区别于门拒绝）。
  items: z.array(SupplyPlanItemV1).max(25),
  // 全局预算声明：planner 自报本计划预计消耗的 jyeoo 付费题数；机器门校验
  // 声明值 ≤ 当日剩余预算（执行侧预算硬闸仍在工具层，声明只是需求侧自约束）。
  budget: z.object({
    jyeoo_questions: z.number().int().min(0).max(40),
  }),
});

export type SupplyPlanItemV1T = z.infer<typeof SupplyPlanItemV1>;
export type SupplyPlanV1T = z.infer<typeof SupplyPlanV1>;
