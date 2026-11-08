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
        load: () => import('./server/web-supply').then((m) => m.buildWebSupplyObserveSubscriber),
      },
    ],
  },
  jobs: {
    handlers: [
      {
        name: 'question_preparer_run',
        queue: 'llm',
        includeMetadata: true,
        load: () =>
          import('./jobs/question_preparer_run').then((m) => m.buildQuestionPreparerHandler),
      },
      {
        name: 'question_preparer_recovery',
        schedule: { cron: '*/5 * * * *', tz: 'Asia/Shanghai' },
        queue: 'fast',
        load: () =>
          import('./server/question-preparer-journal').then(
            (m) => m.buildQuestionPreparerRecoveryHandler,
          ),
      },
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
        // YUK-758 DAG 成员。**边考据修订（review To-Iq + ToTas，两位 reviewer 各对一半）**：
        //  · 原声明的 `answer_class_backfill` 硬边**不成立，已移除**：supply 的
        //    discoverSupplyTargets → assembleScanInput → loadQuestionPool 是
        //    target-discovery.ts 内的**私有** loader（:664），并非 Practice quiz/pool-fetch；
        //    它只 select id/kind/source/metadata/difficulty/knowledge_ids(+draft_status 谓词)，
        //    全 src/server/question-supply/ 目录 grep 不到 answer_class。pool-fetch 也不按
        //    answer_class 过滤。故原「answer_class 新鲜 → 缺口判定准」是伪依赖。
        //  · 改声明 `recalibration_nightly` 硬边（**真读后写**）：同一个私有 loadQuestionPool
        //    在 target-discovery.ts:684-699 批量读 item_calibration(track='hard') 的
        //    b/b_anchor/b_post → effectiveB(= b_post ?? b_anchor ?? b，YUK-439)，该值喂 R3 的
        //    「无近-θ̂ 锚」判定（:490-511）并直接决定是否派**付费** diagnostic 供给目标。
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
      // 轮询，与学习活跃度无关（无 eligibility 门）。付费投递失败后的快速重派不依赖
      // 本 job：投递失败点直接交接（placement-starter-web-delivery →
      // handOffFailedPlacementDelivery），这里只兜从未派出或交接失败的 pending_dispatch
      // 与僵尸 retry 收割。无到期 claim 时一次索引 LIMIT 1 读即退，不触 pg-boss /
      // provider。queue=fast：本 job 自身零 LLM（付费发生在它重派的 quiz_gen /
      // supply_execute），无 DLQ——漏一拍下轮 cron 接上；多 worker 并发靠 claim 的条件
      // UPDATE CAS 领取，单飞语义不变。
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
        name: 'scan_coverage_gaps',
        load: () => import('./tools/scan-coverage-gaps').then((m) => m.scanCoverageGapsTool),
      },
      {
        name: 'submit_question',
        load: () => import('./tools/submit-question').then((m) => m.submitQuestionTool),
      },
    ],
  },
};
