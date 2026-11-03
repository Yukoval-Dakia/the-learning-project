// 结算与撤回重放 owner 的 manifest 片段，由根 `manifest.ts` 组合。
import { API_ERROR_RESPONSES } from '@/kernel/http-contracts';
import type { CapabilityManifest } from '@/kernel/manifest';
import { AppealResponseSchema, CreateAppealBodySchema } from '../api/contracts';

export const settlementManifestPart: Omit<CapabilityManifest, 'name' | 'description'> = {
  api: {
    routes: [
      {
        method: 'POST',
        path: '/api/appeals',
        operationId: 'createAppeal',
        request: { body: CreateAppealBodySchema },
        responses: { 201: AppealResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/appeal').then((m) => m.createAppealResource),
      },
    ],
  },
  jobs: {
    handlers: [
      // YUK-870 (F3.5b) — rejudge 注册自中央渐缩簿收编（等价平移红线：LLM 档
      // 1h expire + DLQ、非默认 1s polling、batchSize 1——原中央行的 inline 动态
      // import + handleRejudge 循环 flatten 成 jobs/rejudge.ts 的标准工厂）。
      {
        name: 'rejudge',
        queue: 'llm',
        pollingIntervalSeconds: 1,
        batchSize: 1,
        load: () => import('./jobs/rejudge').then((m) => m.buildRejudgeHandler),
      },
    ],
  },
  proposals: {
    kinds: [
      // judge_retraction accept：判分纠错提案（evaluation 目标走
      // appeal/rejudge/CAS 激活 + settlement replay；legacy judge-event 目标写
      // CorrectEvent）。真身在 ./server/judge-retraction-applier。
      {
        kind: 'judge_retraction',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.judgeRetractionProposalAcceptApplier,
            ),
        },
      },
    ],
  },
  copilotTools: {
    tools: [
      // YUK-1407 — 判分纠错提案工具（judge_retraction→evaluation）。授予
      // copilot/dreaming/coach 三个发现疑似误判的 agent 面（allowlists.ts）。
      {
        name: 'propose_grading_correction',
        load: () =>
          import('./tools/propose-grading-correction').then((m) => m.proposeGradingCorrectionTool),
      },
    ],
  },
};
