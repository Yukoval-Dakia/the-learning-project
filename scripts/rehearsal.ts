// YUK-1057 — 隔离 cutover/restore/migration 演练入口。
//
//   pnpm rehearsal:cutover [--out=<dir>]
//
// 默认工件根：.remember/rehearsal/<UTC-ts>/（gitignored）。
//
// 安全边界（写死的护栏，不靠纪律）：
//   1. DATABASE_URL 无条件改指不可达占位 —— 任何模块意外走 @/db/client
//      单例时 fail-fast（connection refused），永远不可能落到 .env / 真实
//      DATABASE_URL 指向的库。所有真实 IO 都走 ephemeral 容器连接串。
//   2. 唯一 Postgres 目标是 startEphemeralPg() 起的一次性 testcontainer；
//      compose 容器（the-learning-project-*）从不触碰。
//   3. blob 走 isolatedBlobStore（本地目录 R2Client 假身）；无 R2 env、无
//      provider key、无模型 egress。
//   4. 进程不读 .env（不 import load-env —— 演练必须可证明与生产配置无关）。

// 必须在一切 app import 之前 —— getServerEnv() 在模块装载即校验。
process.env.DATABASE_URL = 'postgres://rehearsal:rehearsal@127.0.0.1:1/rehearsal_stub';

function parseArgs(argv: string[]): { out: string | null } {
  const readFlag = (flag: string): string | null => {
    const eq = argv.find((a) => a.startsWith(`--${flag}=`));
    if (eq) return eq.slice(`--${flag}=`.length);
    const idx = argv.indexOf(`--${flag}`);
    if (idx !== -1 && idx + 1 < argv.length && !argv[idx + 1].startsWith('--')) {
      return argv[idx + 1];
    }
    return null;
  };
  return { out: readFlag('out') };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const { resolve } = await import('node:path');
  const out = args.out === null ? resolve('.remember', 'rehearsal', ts) : resolve(args.out);

  const { runRehearsal } = await import('@/server/rehearsal/orchestrate');
  const report = await runRehearsal({ out });

  console.log(`\n[rehearsal] report: ${report.out_dir}/report.json`);
  const acc = report.acceptance;
  for (const [k, v] of Object.entries(acc)) {
    console.log(`  ${v ? '✓' : '✗'} ${k}`);
  }
  const failed = report.steps.filter((s) => s.status === 'failed');
  const allGreen = Object.values(acc).every(Boolean) && failed.length === 0;
  console.log(`[rehearsal] ${allGreen ? 'ALL GREEN' : 'INCOMPLETE — see steps.jsonl'}`);
  process.exit(allGreen ? 0 : 2);
}

await main();

export {};
