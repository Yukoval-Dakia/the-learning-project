// YUK-1057 / D18 — eval harness 就绪运行器。
//
//   pnpm eval:d18 --target=<postgres-url> [--run-id=<id>] [--out=<dir>]
//                 [--items=<N>] [--attempts=<N>] [--lane=stub|jev-openrouter]
//
// Lane：
//   - stub（默认）：确定性 echo invoker，零 egress —— harness/gate/metrics/
//     封存的就绪证明车道。
//   - jev-openrouter（YUK-1058 owner 授权 live lane）：每 item 经
//     runTypedPrimitiveTask('JevScoringDecisionTask') 调 OpenRouter
//     POST /api/v1/systemone（TypeSafe Jev 1.13 pin）。需要
//     OPENROUTER_API_KEY（本脚本不读 .env，须导出到进程 env）。
//     双写封存：JevScoringDecisionTask attempt 行（provider 原生 cost）+
//     D18EvalHarness 证据行（provider='openrouter', model='typesafe/jev-1.13'）。
// 证明面（D18 gate-ready）：
//   - EvalBudgetGate 真账本：admit → invoke → settle，触顶 latch + halt。
//   - 证据双封存：NDJSON（<out>/evidence.ndjson）+ ai_task_runs
//     （task_kind='D18EvalHarness'，input/result digest、usage/cost/score/
//     latency 照实入账）。
//   - 指标聚合（YUK-1058）：error_rate / point_error / severe_error_rate /
//     upgrade_coverage / cost / latency，按 dev/holdout/all split 出
//     <out>/d18-metrics.json（stub corpus 无 gold → 判分指标为 null；
//     jev corpus 每 item 带 expect → 全指标实算）。
//   - invoker lane：stub + jev-openrouter（src/server/eval/d18-jev-invoker.ts，
//     复用 YUK-1049 typed runner 的 model pin/重试/成本真相）。未实现 lane
//     （mimo-*）显式拒绝。jev corpus 是 seal 管线证明，非判分质量结论。
//
// 安全：--target 必须显式（写 ai_task_runs 是写路径，不回退 DATABASE_URL）；
// DATABASE_URL 在 import 前改指不可达占位，防止任何意外单例回退。

process.env.DATABASE_URL = 'postgres://rehearsal:rehearsal@127.0.0.1:1/rehearsal_stub';

import { resolve } from 'node:path';

import type { EvalCorpusItem, EvalEvidenceEntry, EvalInvoker } from '@/core/eval/d18-harness';

interface D18Args {
  target: string | null;
  runId: string;
  out: string;
  items: number;
  attempts: number;
  lane: string;
}

function parseArgs(argv: string[]): D18Args {
  const readFlag = (flag: string): string | null => {
    const eq = argv.find((a) => a.startsWith(`--${flag}=`));
    if (eq) return eq.slice(`--${flag}=`.length);
    const idx = argv.indexOf(`--${flag}`);
    if (idx !== -1 && idx + 1 < argv.length && !argv[idx + 1].startsWith('--')) {
      return argv[idx + 1];
    }
    return null;
  };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const items = Number.parseInt(readFlag('items') ?? '20', 10);
  const attempts = Number.parseInt(readFlag('attempts') ?? '1', 10);
  return {
    target: readFlag('target'),
    runId: readFlag('run-id') ?? `d18-${ts}`,
    out: resolve(readFlag('out') ?? `.remember/rehearsal/d18-${ts}`),
    items: Number.isFinite(items) && items > 0 ? items : 20,
    attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 1,
    lane: readFlag('lane') ?? 'stub',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.target === null || args.target.trim().length === 0) {
    console.error('missing --target=<postgres-url>（ai_task_runs 封存是写路径，必须显式目标）');
    process.exit(1);
  }
  // YUK-1058：lane 白名单 —— stub（无 egress）与 jev-openrouter（owner-
  // 授权的 live lane，OPENROUTER_API_KEY 走 typed-primitive-runner）。
  // 其余名（mimo-text/mimo-vision 等）显式拒绝，防止误启未实现 egress。
  const KNOWN_LANES = new Set(['stub', 'jev-openrouter']);
  if (!KNOWN_LANES.has(args.lane)) {
    console.error(
      `unknown --lane=${args.lane}: implemented lanes are 'stub' (no egress) and ` +
        `'jev-openrouter' (TypeSafe Jev via OPENROUTER_API_KEY). Other lanes wire later.`,
    );
    process.exit(1);
  }
  if (args.lane === 'jev-openrouter' && !process.env.OPENROUTER_API_KEY) {
    console.error(
      '--lane=jev-openrouter requires OPENROUTER_API_KEY in env (not loaded from .env by this script)',
    );
    process.exit(1);
  }

  const { drizzle } = await import('drizzle-orm/postgres-js');
  const postgres = (await import('postgres')).default;
  const schema = await import('@/db/schema');
  const { runEvalHarness, stubInvoker } = await import('@/core/eval/d18-harness');
  const { computeD18Metrics } = await import('@/core/eval/d18-metrics');
  const { fileEvidenceSink, aiTaskRunEvidenceSink } = await import('@/server/eval/d18-seal');
  const { canonicalHash } = await import('@/core/migration/canonical');
  const { writeProof } = await import('@/server/rehearsal/db-proof');

  // 语料按 lane 成形：stub 原样合成 echo 请求；jev-openrouter 的 request
  // 必须是 JevScoringDecisionInput（{state, questions} strict）。jev 语料为
  // 每 item 一题 noul（二元 claim 判定），state 带学生作答 + 参考标准；
  // 半数为正确、半数为错误的显然样本并带 gold —— 判分指标全路径跑通
  // （本 corpus 是 seal/metrics 管线证明，不是判分质量结论）。
  const corpus: EvalCorpusItem[] = Array.from({ length: args.items }, (_, i) => {
    const id = `d18-item-${String(i).padStart(3, '0')}`;
    const split = (i % 5 === 4 ? 'holdout' : 'dev') as 'dev' | 'holdout';
    if (args.lane === 'jev-openrouter') {
      const correct = i % 2 === 0;
      // 半数 item 是真算术错误（答案错 1），gold=0；半数正确，gold=4。
      // gold 是 seal/metrics 管线的判错锚 —— 不是判分质量结论（runbook）。
      const claim = `The student asserts that 2+${i} equals ${correct ? 2 + i : 3 + i}`;
      return {
        id,
        split,
        request: {
          state: {
            submission: { entries: [{ slot_id: 's1', kind: 'text', text_md: claim }] },
            materials: [
              {
                material_id: 'ref',
                kind: 'reference',
                content_md: `The correct value of 2+${i} is ${2 + i}.`,
              },
            ],
          },
          questions: {
            [id]: {
              type: 'noul' as const,
              instructions: 'Does the student statement match the reference?',
              criteria: {
                true: `The student's claim is arithmetically correct.`,
                false: `The student's claim is arithmetically wrong.`,
              },
            },
          },
        },
        expect: { max_points: 4, gold_points: correct ? 4 : 0 },
      };
    }
    return {
      id,
      split,
      request: {
        kind: 'judge-verify',
        item_hash: canonicalHash({ i, seed: 'd18-readiness' }),
        prompt_excerpt: `synthetic readiness item ${i} — replace with real corpus in eval ticket`,
      },
    };
  });

  const client = postgres(args.target, {
    ssl:
      /localhost|127\.0\.0\.1/.test(args.target) || /[?&]sslmode=disable\b/.test(args.target)
        ? false
        : 'require',
    max: 2,
  });
  const db = drizzle(client, { schema }) as never;

  const fileSink = fileEvidenceSink(`${args.out}/evidence.ndjson`);
  // 封存行 provider/model 照 lane 事实入账：stub → 'stub'；jev-openrouter
  // → openrouter / typesafe/jev-1.13（与 typed runner 的 attempt 行一致）。
  const jevLane =
    args.lane === 'jev-openrouter' ? await import('@/server/eval/d18-jev-invoker') : null;
  const sealProvider = jevLane?.JEV_LANE_PROVIDER ?? 'stub';
  const sealModel = jevLane?.JEV_LANE_MODEL;
  const dbSink = aiTaskRunEvidenceSink(db as never, {
    provider: sealProvider,
    ...(sealModel !== undefined ? { model: sealModel } : {}),
  });
  // YUK-1058：证据行内存累积 —— metrics 聚合输入（行数 = invocations，
  // D18 上限 800，内存可忽略）。
  const collected: EvalEvidenceEntry[] = [];
  const sink = {
    async record(entry: EvalEvidenceEntry) {
      collected.push(entry);
      await fileSink.record(entry);
      await dbSink.record(entry);
    },
    async close() {
      await fileSink.close();
      await dbSink.close();
    },
  };

  try {
    const invoker: EvalInvoker =
      jevLane !== null
        ? jevLane.jevOpenRouterInvoker({
            db: db as never,
          })
        : stubInvoker({ lane: args.lane });
    const report = await runEvalHarness({
      runId: args.runId,
      corpus,
      invoker,
      sink,
      maxAttemptsPerItem: args.attempts,
    });
    // D18 metrics（YUK-1058）：jev corpus 带 expect → 判分指标实算；stub
    // corpus 无 gold → 判分指标 null（正确性由 d18-metrics.test.ts 证明）。
    const expectations = new Map<string, { max_points: number; gold_points: number }>();
    for (const item of corpus) {
      if (item.expect !== undefined) expectations.set(item.id, item.expect);
    }
    const metrics = computeD18Metrics(args.runId, collected, expectations);
    writeProof(args.out, 'd18-metrics.json', metrics);
    writeProof(args.out, 'd18-report.json', report);
    console.log(
      `[eval-d18] run ${report.run_id}: attempted=${report.items_attempted}/${report.items_planned} invocations=${report.invocations} halted=${String(report.halted)}`,
    );
    console.log(
      `[eval-d18] ledger: spent=$${report.ledger.spentUsd.toFixed(4)} requests=${report.ledger.requests} verification=${report.ledger.verificationCalls} halt=${report.ledger.haltReason ?? 'none'}`,
    );
    const all = metrics.splits.all;
    console.log(
      `[eval-d18] metrics(all): evaluated=${all.items_evaluated} gold=${all.items_with_gold} ` +
        `error_rate=${all.error_rate ?? 'n/a'} point_error=${all.point_error ?? 'n/a'} ` +
        `escalation_cov=${all.upgrade_coverage ?? 'n/a'} p95_ms=${all.latency_ms.p95 ?? 'n/a'}`,
    );
    console.log(
      `[eval-d18] evidence: ${args.out}/evidence.ndjson + ai_task_runs (task_kind=D18EvalHarness)`,
    );
    console.log(`[eval-d18] report: ${args.out}/d18-report.json + d18-metrics.json`);
    process.exit(report.halted ? 2 : 0);
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

await main();
