// 一次性重封：内容没改、但库存摘要是调用方键序，读方按 jsonb 键序对不上的 revision。
//
// 读方仍然只认三份从存库层重算的封印（规范、schema 键序、存库 jsonb 键序）。
// 故意改过的层重算不出原来的摘要，脚本留下不写，准入继续 stale。
// 已经对得上的旧规范 / 旧 schema 封印不改，题库 ref 前缀保持原样。
//
// 会改写的行：question_revision.integrity_digest 换成规范封印。
// 不改写核验历史、发布事件。已发出的 qrev1 ref 前缀会失效，要按新摘要重取。
// 队列里钉着旧摘要的准入作业会 stale，重封之后需要重新入队，本脚本不入队。
//
//   pnpm exec tsx scripts/reseal-admission-digest.ts              # 只报告
//   pnpm exec tsx scripts/reseal-admission-digest.ts --apply      # 写入

import './load-env';

import { and, eq } from 'drizzle-orm';
import { question_revision } from '@/db/schema';
import {
  classifyStoredRevisionDigest,
  layersOfStoredRevision,
  resealDecision,
} from '@/kernel/records/admission-digest-reseal';

const APPLY = process.argv.includes('--apply');

function rejectUnknownArgs(): void {
  for (const arg of process.argv.slice(2)) {
    if (arg !== '--apply') throw new Error(`unknown argument: ${arg}`);
  }
}

async function reportDatabase(): Promise<void> {
  const { db } = await import('@/db/client');
  const rows = await db
    .select({
      revision_id: question_revision.revision_id,
      group_id: question_revision.group_id,
      integrity_digest: question_revision.integrity_digest,
      structure: question_revision.structure,
      response_spec: question_revision.response_spec,
      scoring_basis: question_revision.scoring_basis,
      execution_plan: question_revision.execution_plan,
      presentation: question_revision.presentation,
    })
    .from(question_revision);

  const counts = { keep: 0, rewrite: 0, leave_stale: 0 };
  const rewrite: { revision_id: string; group_id: string; from: string; to: string }[] = [];
  const stale: { revision_id: string; group_id: string }[] = [];
  for (const row of rows) {
    const decision = resealDecision(
      classifyStoredRevisionDigest(layersOfStoredRevision(row), row.integrity_digest),
    );
    counts[decision.action] += 1;
    if (decision.action === 'rewrite') {
      rewrite.push({
        revision_id: row.revision_id,
        group_id: row.group_id,
        from: row.integrity_digest,
        to: decision.canonical,
      });
    } else if (decision.action === 'leave_stale') {
      stale.push({ revision_id: row.revision_id, group_id: row.group_id });
    }
  }

  let updated = 0;
  if (APPLY && rewrite.length > 0) {
    updated = await db.transaction(async (tx) => {
      let wrote = 0;
      for (const row of rewrite) {
        const changed = await tx
          .update(question_revision)
          .set({ integrity_digest: row.to })
          .where(
            and(
              eq(question_revision.revision_id, row.revision_id),
              eq(question_revision.integrity_digest, row.from),
            ),
          )
          .returning({ revision_id: question_revision.revision_id });
        wrote += changed.length;
      }
      return wrote;
    });
  }

  console.log(
    JSON.stringify({
      mode: APPLY ? 'apply' : 'dry_run',
      revisions: rows.length,
      keep: counts.keep,
      rewrite: counts.rewrite,
      leave_stale: counts.leave_stale,
      updated,
      rewrite_rows: rewrite,
      stale,
    }),
  );
}

rejectUnknownArgs();
reportDatabase().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
