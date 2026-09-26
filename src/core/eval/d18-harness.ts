// ====================================================================
// YUK-1057 — D18 独立评测 harness 核心（纯函数 + 注入 seam）
// ====================================================================
//
// 「harness + budget gate 就绪」的 harness 本体：语料驱动、每调用先过
// EvalBudgetGate.admit、调用返回后 settle + 证据 sink 追加。模型调用被
// EvalInvoker seam 隔离 —— 本票只交付 stub invoker（无 live egress；
// D18 评测本体在 harness 就绪证明后另行运行，见 runbook）。
//
// 证据封存：EvidenceSink 是 file/DB 无关的 append seam；生产证据面是
// app `ai_task_runs`（src/server/eval/d18-seal.ts 的 adapter 走既有
// writeAiTaskRunStarted/writeAiTaskRunFinished writer），file sink 供
// 演练/单测落地 raw 工件。

import { canonicalHash, sha256Hex } from '../migration/canonical';
import {
  BudgetHaltError,
  type EvalBudgetCaps,
  EvalBudgetGate,
  type EvalCallEstimate,
} from './d18-budget';

/** 语料条目（dev/holdout 样本；内容形状由后续评测合同定义）。 */
export interface EvalCorpusItem {
  id: string;
  /** 'dev' 阈值调优集 | 'holdout' 留出集（D17：holdout 不得再调）。 */
  split: 'dev' | 'holdout';
  /** 请求体（由 invoker lane 自行解释；harness 不透传形状）。 */
  request: unknown;
}

export interface EvalInvocationRequest {
  item: EvalCorpusItem;
  /** 该 item 的第几次尝试（1-based；retries 计入预算）。 */
  attempt: number;
}

export interface EvalInvocationResult {
  /** 模型输出（原文/digest 由 sink 决定如何封存）。 */
  output: unknown;
  usage: { inputTokens: number; outputTokens: number };
  /** provider 报告的成本（USD）；未知 → null 走保守记账。 */
  reportedCostUsd: number | null;
}

/**
 * 模型调用 seam。Ready 状态下唯一实现是 stub —— harness 就绪证明不触
 * 任何 provider。真实 invoker（OpenRouter Jev typed / MiMo）由后续评测票
 * 实现并复用本 gate/账本。
 */
export interface EvalInvoker {
  /** lane 名（'jev-openrouter' | 'mimo-text' | 'mimo-vision' | 'stub'）。 */
  lane: string;
  invoke(req: EvalInvocationRequest): Promise<EvalInvocationResult>;
  /** 该 item 调用前的成本估计（未知 → null，gate 按保守 reserve 预留）。 */
  estimate(req: EvalInvocationRequest): EvalCallEstimate;
}

/** 证据 sink：每次 invocation 一条记录（input/output digest + usage/cost）。 */
export interface EvalEvidenceSink {
  record(entry: EvalEvidenceEntry): Promise<void>;
  close(): Promise<void>;
}

export interface EvalEvidenceEntry {
  run_id: string;
  item_id: string;
  split: EvalCorpusItem['split'];
  attempt: number;
  lane: string;
  kind: EvalCallEstimate['kind'];
  input_digest: string;
  output_digest: string;
  usage: { inputTokens: number; outputTokens: number };
  cost_usd: number | null;
  /** ai_task_runs cost truth 对齐：reported=sdk/invoker 实报，estimated=价目
   *  表估算，unknown=无报价；ref 指向成本证据来源（pricebook/sdk/stub）。 */
  cost_basis: 'reported' | 'estimated' | 'unknown' | null;
  cost_ref: string | null;
  /** 本次调用是否被 gate 拒绝（触顶调用没有 output）。 */
  outcome: 'settled' | 'gate_rejected' | 'invoke_failed';
  error: string | null;
  recorded_at: string;
}

export interface EvalRunReport {
  run_id: string;
  lane: string;
  items_planned: number;
  items_attempted: number;
  invocations: number;
  retries: number;
  ledger: ReturnType<EvalBudgetGate['ledger']>;
  halted: boolean;
  halt_reason: string | null;
  failures: Array<{ item_id: string; attempt: number; error: string }>;
}

export interface EvalHarnessOptions {
  runId: string;
  corpus: readonly EvalCorpusItem[];
  invoker: EvalInvoker;
  sink: EvalEvidenceSink;
  caps?: EvalBudgetCaps;
  /** 每 item 最大尝试次数（默认 1 —— 无 retry）。retries 计入预算上限。 */
  maxAttemptsPerItem?: number;
  /** 调用 kind（默认 'verification'；escalation 调用走 invoker 自行 admit）。 */
  kind?: EvalCallEstimate['kind'];
  now?: () => Date;
}

/** invocation 记录 digest（input/output canonical hash；原文不进报告）。 */
function digests(req: EvalInvocationRequest, output: unknown) {
  return {
    input: sha256Hex(canonicalHash({ item: req.item.id, request: req.item.request })),
    output: sha256Hex(canonicalHash(output ?? null)),
  };
}

/**
 * 评测主循环：逐 item、逐 attempt —— admit → invoke → settle → sink.record。
 * 触顶即停：BudgetHaltError 冒泡前记录 gate_rejected 证据并终止整轮
 * （不继续下一个 item —— latch 语义，D18「首次触顶即停」）。
 * invoker 自身错误：该 item 记 invoke_failed 并继续下一 item（语料级失败
 * 不是预算事件）；输出为空也照实入账。
 */
export async function runEvalHarness(opts: EvalHarnessOptions): Promise<EvalRunReport> {
  const gate = new EvalBudgetGate(opts.caps);
  const kind = opts.kind ?? 'verification';
  const maxAttempts = Math.max(1, opts.maxAttemptsPerItem ?? 1);
  const now = opts.now ?? (() => new Date());
  const failures: EvalRunReport['failures'] = [];
  let invocations = 0;
  let retries = 0;
  let attempted = 0;

  const record = async (
    req: EvalInvocationRequest,
    outcome: EvalEvidenceEntry['outcome'],
    result: EvalInvocationResult | null,
    error: string | null,
    estimate: EvalCallEstimate | null,
  ): Promise<void> => {
    const d = digests(req, result?.output ?? null);
    await opts.sink.record({
      run_id: opts.runId,
      item_id: req.item.id,
      split: req.item.split,
      attempt: req.attempt,
      lane: opts.invoker.lane,
      kind,
      input_digest: d.input,
      output_digest: outcome === 'settled' ? d.output : '',
      usage: result?.usage ?? { inputTokens: 0, outputTokens: 0 },
      cost_usd: result?.reportedCostUsd ?? null,
      cost_basis:
        result?.reportedCostUsd != null
          ? 'reported'
          : estimate?.estimatedCostUsd != null
            ? 'estimated'
            : 'unknown',
      cost_ref:
        result?.reportedCostUsd != null
          ? `invoker:${opts.invoker.lane}:reported_cost_usd`
          : estimate?.estimatedCostUsd != null
            ? `invoker:${opts.invoker.lane}:estimate`
            : `unpriced:${opts.invoker.lane}`,
      outcome,
      error,
      recorded_at: now().toISOString(),
    });
  };

  try {
    for (const item of opts.corpus) {
      if (gate.halted) break;
      let settled = false;
      for (let attempt = 1; attempt <= maxAttempts && !settled; attempt++) {
        const req: EvalInvocationRequest = { item, attempt };
        const estimate = opts.invoker.estimate(req);
        // caller 侧 fail-closed：先 admit，admit 过了才发起模型调用。
        // BudgetHaltError 前先落一条 gate_rejected 证据行（触顶调用本身
        // 也是审计证据 —— 报告 failures 不覆盖 invocations 维度）。
        try {
          gate.admit({ ...estimate, kind });
        } catch (err) {
          if (err instanceof BudgetHaltError) {
            await record(req, 'gate_rejected', null, err.message, estimate);
          }
          throw err;
        }
        invocations += 1;
        if (attempt > 1) retries += 1;
        if (attempt === 1) attempted += 1;
        try {
          const result = await opts.invoker.invoke(req);
          gate.settle({
            kind,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            actualCostUsd: result.reportedCostUsd,
            estimatedCostUsd: estimate.estimatedCostUsd,
          });
          await record(req, 'settled', result, null, estimate);
          settled = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await record(req, 'invoke_failed', null, message, estimate);
          failures.push({ item_id: item.id, attempt, error: message });
          // invoke 失败不收 cost（无 reported usage 可入账）；attempt 已计入
          // requests —— retries 计入上限的语义保持（下一次 attempt 走新 admit）。
          if (attempt < maxAttempts) continue;
        }
      }
    }
  } catch (err) {
    if (err instanceof BudgetHaltError) {
      // 触顶即停：本轮 run 在这里结束（latch 已由 gate 记录）。
      return {
        run_id: opts.runId,
        lane: opts.invoker.lane,
        items_planned: opts.corpus.length,
        items_attempted: attempted,
        invocations,
        retries,
        ledger: gate.ledger(),
        halted: true,
        halt_reason: err.reason,
        failures,
      };
    }
    throw err;
  } finally {
    await opts.sink.close();
  }

  return {
    run_id: opts.runId,
    lane: opts.invoker.lane,
    items_planned: opts.corpus.length,
    items_attempted: attempted,
    invocations,
    retries,
    ledger: gate.ledger(),
    halted: gate.halted,
    halt_reason: gate.ledger().haltReason,
    failures,
  };
}

// ───────────────────────── stub invoker（无 egress） ─────────────────────────

export interface StubInvokerOptions {
  lane?: string;
  /** 每 item 固定 usage；可按 item.id 散列微调以贴近真实分布。 */
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

/**
 * 合成 invoker：确定性 echo（输出 = 输入 digest），绝不发任何网络请求。
 * harness 就绪证明 / CI 合成超预算驱动专用 —— D18 actual-output 评测禁止
 * 用 stub（真实 lane 由评测票实现）。
 */
export function stubInvoker(opts: StubInvokerOptions = {}): EvalInvoker {
  const lane = opts.lane ?? 'stub';
  return {
    lane,
    estimate(_req) {
      return {
        kind: 'verification',
        inputTokens: opts.inputTokens ?? 512,
        outputTokens: opts.outputTokens ?? 256,
        estimatedCostUsd: opts.costUsd ?? null,
      };
    },
    async invoke(req) {
      return {
        output: {
          stub: true,
          echo: digests(req, null).input,
          item_id: req.item.id,
          attempt: req.attempt,
        },
        usage: {
          inputTokens: opts.inputTokens ?? 512,
          outputTokens: opts.outputTokens ?? 256,
        },
        reportedCostUsd: opts.costUsd ?? null,
      };
    },
  };
}
