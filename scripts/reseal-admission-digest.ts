// 一次性重封：内容没改、但库存摘要是调用方键序，读方按 jsonb 键序对不上的 revision。
//
// 读方仍然只认三份从存库层重算的封印（规范、schema 键序、存库 jsonb 键序）。
// 故意改过的层重算不出原来的摘要，脚本留下不写，准入继续 stale。
// 已经对得上的旧规范 / 旧 schema 封印不改，题库 ref 前缀保持原样。
//
// 已发出的发题和作答仍钉着旧 revision。已发出的 qrev1 前缀会失效，要按新摘要重取。
// 队列里钉着旧摘要的准入作业会 stale。重封之后重新入队。本脚本不入队。
// 核验记录留在旧 revision 上。
//
//   pnpm exec tsx scripts/reseal-admission-digest.ts              # 只报告
//   pnpm exec tsx scripts/reseal-admission-digest.ts --apply      # 写入

import { pathToFileURL } from 'node:url';

import './load-env';

import { errorText, resealAdmissionDigests } from '@/kernel/records/admission-digest-reseal';

const APPLY = process.argv.includes('--apply');

function rejectUnknownArgs(): void {
  for (const arg of process.argv.slice(2)) {
    if (arg !== '--apply') throw new Error(`unknown argument: ${arg}`);
  }
}

async function reportDatabase(): Promise<number> {
  const { db } = await import('@/db/client');
  const report = await resealAdmissionDigests(db, {
    apply: APPLY,
    ...(APPLY
      ? {
          readAssetBytes: async (storageKey: string) => {
            const { getR2 } = await import('@/server/r2');
            return getR2().get(storageKey);
          },
        }
      : {}),
  });
  console.log(JSON.stringify(report));
  if (report.failed.length === 0) return 0;
  console.error(report.failed.map((row) => row.cause).join('\n'));
  return 1;
}

async function main(): Promise<void> {
  try {
    rejectUnknownArgs();
    process.exitCode = await reportDatabase();
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  } finally {
    try {
      const { db } = await import('@/db/client');
      await db.$client.end({ timeout: 5 });
    } catch {
      // 报告已经打出。关闭失败不能改出口码。
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
