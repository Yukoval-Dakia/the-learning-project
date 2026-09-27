// YUK-1057 / D18 — eval harness 就绪运行器（stub invoker，无模型 egress）。
//
//   pnpm eval:d18 --target=<postgres-url> [--run-id=<id>] [--out=<dir>]
//                 [--items=<N>] [--attempts=<N>] [--lane=stub]
//
// 证明面（D18 gate-ready）：
//   - EvalBudgetGate 真账本：admit → invoke → settle，触顶 latch + halt。
//   - 证据双封存：NDJSON（<out>/evidence.ndjson）+ ai_task_runs
//     （task_kind='D18EvalHarness'，input/result digest、usage/cost/score/
//     latency 照实入账）。
//   - 指标聚合（YUK-1058）：error_rate / point_error / severe_error_rate /
//     upgrade_coverage / cost / latency，按 dev/holdout/all split 出
//     <out>/d18-metrics.json（stub corpus 无 gold → 判分指标为 null，指标
//     层正确性由 d18-metrics.test.ts 证明；actual-output run 时自动填充）。
//   - invoker 目前只有 stub：真实 lane（OpenRouter Jev / MiMo）由评测票实现
//     并复用本 gate/账本/封存/指标。`--lane` 只接受 'stub'；传其他 lane 名
//     显式拒绝（防止误启 live egress）。
//
// 安全：--target 必须显式（写 ai_task_runs 是写路径，不回退 DATABASE_URL）；
// DATABASE_URL 在 import 前改指不可达占位，防止任何意外单例回退。

process.env.DATABASE_URL = 'postgres://rehearsal:rehearsal@127.0.0.1:1/rehearsal_stub';

import { resolve } from 'node:path';

import type { EvalCorpusItem, EvalEvidenceEntry } from '@/core/eval/d18-harness';

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
  // YUK-1058：唯一已实现的 lane 是 stub（无 egress）。显式拒绝任何其他 lane
  // 名——评测票落地真实 invoker 时把该 lane 名加进下表并接 EvalInvoker。
  if (args.lane !== 'stub') {
    console.error(
      `unknown --lane=${args.lane}: this runner only implements 'stub' (no egress). ` +
        'Real lanes (jev-openrouter/mimo-text/mimo-vision) plug an EvalInvoker in the eval ticket.',
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

  // 合成语料：dev/holdout 双 split；request 形状由 lane 自行解释（stub echo）。
  const corpus: EvalCorpusItem[] = Array.from({ length: args.items }, (_, i) => ({
    id: `d18-item-${String(i).padStart(3, '0')}`,
    split: (i % 5 === 4 ? 'holdout' : 'dev') as 'dev' | 'holdout',
    request: {
      kind: 'judge-verify',
      item_hash: canonicalHash({ i, seed: 'd18-readiness' }),
      prompt_excerpt: `synthetic readiness item ${i} — replace with real corpus in eval ticket`,
    },
  }));

  const client = postgres(args.target, {
    ssl:
      /localhost|127\.0\.0\.1/.test(args.target) || /[?&]sslmode=disable\b/.test(args.target)
        ? false
        : 'require',
    max: 2,
  });
  const db = drizzle(client, { schema }) as never;

  const fileSink = fileEvidenceSink(`${args.out}/evidence.ndjson`);
  const dbSink = aiTaskRunEvidenceSink(db as never, { provider: 'stub' });
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
    const report = await runEvalHarness({
      runId: args.runId,
      corpus,
      invoker: stubInvoker({ lane: args.lane }),
      sink,
      maxAttemptsPerItem: args.attempts,
    });
    // D18 metrics（YUK-1058）：合成 corpus 未带 expect → 判分指标为 null；
    // 指标层正确性由 d18-metrics.test.ts 证明，actual-output run 自动填充。
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
