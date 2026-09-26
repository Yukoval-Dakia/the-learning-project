// YUK-1057 / D18 — eval harness 就绪运行器（stub invoker，无模型 egress）。
//
//   pnpm eval:d18 --target=<postgres-url> [--run-id=<id>] [--out=<dir>]
//                 [--items=<N>] [--attempts=<N>]
//
// 证明面（D18 gate-ready）：
//   - EvalBudgetGate 真账本：admit → invoke → settle，触顶 latch + halt。
//   - 证据双封存：NDJSON（<out>/evidence.ndjson）+ ai_task_runs
//     （task_kind='D18EvalHarness'，input/result digest、usage/cost 照实入账）。
//   - invoker 目前只有 stub：真实 lane（OpenRouter Jev / MiMo）由评测票实现，
//     本 runner 证明 harness/封存/预算链就绪。
//
// 安全：--target 必须显式（写 ai_task_runs 是写路径，不回退 DATABASE_URL）；
// DATABASE_URL 在 import 前改指不可达占位，防止任何意外单例回退。

process.env.DATABASE_URL = 'postgres://rehearsal:rehearsal@127.0.0.1:1/rehearsal_stub';

import { resolve } from 'node:path';

interface D18Args {
  target: string | null;
  runId: string;
  out: string;
  items: number;
  attempts: number;
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
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.target === null || args.target.trim().length === 0) {
    console.error('missing --target=<postgres-url>（ai_task_runs 封存是写路径，必须显式目标）');
    process.exit(1);
  }

  const { drizzle } = await import('drizzle-orm/postgres-js');
  const postgres = (await import('postgres')).default;
  const schema = await import('@/db/schema');
  const { runEvalHarness, stubInvoker } = await import('@/core/eval/d18-harness');
  const { fileEvidenceSink, aiTaskRunEvidenceSink } = await import('@/server/eval/d18-seal');
  const { canonicalHash } = await import('@/core/migration/canonical');
  const { writeProof } = await import('@/server/rehearsal/db-proof');

  // 合成语料：dev/holdout 双 split；request 形状由 lane 自行解释（stub echo）。
  const corpus = Array.from({ length: args.items }, (_, i) => ({
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
  const sink = {
    async record(entry: Parameters<typeof fileSink.record>[0]) {
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
      invoker: stubInvoker({ lane: 'stub' }),
      sink,
      maxAttemptsPerItem: args.attempts,
    });
    writeProof(args.out, 'd18-report.json', report);
    console.log(
      `[eval-d18] run ${report.run_id}: attempted=${report.items_attempted}/${report.items_planned} invocations=${report.invocations} halted=${String(report.halted)}`,
    );
    console.log(
      `[eval-d18] ledger: spent=$${report.ledger.spentUsd.toFixed(4)} requests=${report.ledger.requests} verification=${report.ledger.verificationCalls} halt=${report.ledger.haltReason ?? 'none'}`,
    );
    console.log(
      `[eval-d18] evidence: ${args.out}/evidence.ndjson + ai_task_runs (task_kind=D18EvalHarness)`,
    );
    console.log(`[eval-d18] report: ${args.out}/d18-report.json`);
    process.exit(report.halted ? 2 : 0);
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

await main();
