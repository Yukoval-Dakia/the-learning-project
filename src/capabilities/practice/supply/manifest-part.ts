// 供题与备题员 owner 的 manifest 片段，由根 `manifest.ts` 组合；条目随本 owner 的文件迁入。
import type { CapabilityManifest } from '@/kernel/manifest';
import { nightlyEligibility } from '@/kernel/nightly-eligibility';

export const supplyManifestPart: Omit<CapabilityManifest, 'name' | 'description'> = {
  subscriptions: {
    handlers: [
      {
        // YUK-1664: a web demand advances on its question's real publication result, not on
        // the nightly recovery sweep (which stays as the lost-delivery fallback).
        id: 'practice.web-supply-observe',
        version: 1,
        actions: ['experimental:assessment_publish'],
        load: () =>
          import('./server/web-supply').then((m) => m.buildWebSupplyObserveSubscriber),
      },
    ],
  },
  jobs: {
    handlers: [
      // YUK-988 E3 — sourcing 单体 job 退役（找+判+存一体）：找题核下沉
      // web_fetch_candidates（SourcingTask 在工具内部），存由 store_sourced_question
      // commit seam 唯一负责。本入口换为确定性供给执行 job（plan-executor 的
      // pg-boss 面三入口共用：planner phase-2 / dispatcher 安全网 / 手动 caller）。
      {
        name: 'supply_execute',
        queue: 'agent',
        // Placement deliveries need job id/retryCount/startedOn/expiry/signal for attempt authority.
        includeMetadata: true,
        load: () => import('./jobs/supply_execute').then((m) => m.buildSupplyExecuteHandler),
      },
      {
        //    这与 compose 对 recalibration 的既有硬边是**同一列同一 resolver**。上游未 firm-up
        //    就扫 → 拿陈旧 b 误判 mis-banded → 派本不需要的付费 job。经 item_prior_backfill
        //    传递依赖（recalibration ← item_prior），整条标定链齐了才扫。cron 移除。
        name: 'question_supply_nightly',
        dependsOn: ['recalibration_nightly'],
        eligibility: nightlyEligibility('supply'),
        queue: 'llm',
        load: () =>
          import('./jobs/question_supply_nightly').then((m) => m.buildQuestionSupplyNightlyHandler),
      },
      // YUK-1664 — placement starter claim 到期清扫。原挂 question_supply_nightly 尾部：
      // dormant 档整夜不跑、DAG 上游 skipped 连带不跑。改独立高频 job 照
      // intervention_prepare_recovery 范式：按 `next_reconcile_at <= now` 的真实到期义务
      // 轮询，与学习活跃度无关（无 eligibility 门），卡死供给几分钟内恢复。无到期 claim 时
      // 一次索引 LIMIT 1 读即退，不触 pg-boss / provider。queue=fast：本 job 自身零 LLM
      // （付费发生在它重派的 quiz_gen / supply_execute），无 DLQ——漏一拍下轮 cron 接上；
      // 多 worker 并发靠 claim 的条件 UPDATE CAS 领取，单飞语义不变。
      {
        name: 'placement_starter_recovery',
        schedule: { cron: '*/5 * * * *', tz: 'Asia/Shanghai' },
        queue: 'fast',
        load: () =>
          import('./server/placement-starter-recovery').then(
            (m) => m.buildPlacementStarterRecoveryHandler,
          ),
      },
    ],
  },
  copilotTools: {
    tools: [
      {
        name: 'submit_question',
        load: () => import('./tools/submit-question').then((m) => m.submitQuestionTool),
      },
    ],
  },
};
