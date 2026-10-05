// pnpm quiz:reverify — stranded quiz_gen draft 的 quiz_verify 重派 CLI（QoL，2026-09-13）。
//
// 背景：quiz_verify 的 catch-bottom 对判官 SDK 成功但输出解析失败等 transient 错误写
// outcome='error' 事件并重抛；pg-boss 重试耗尽后 job failed，draft 滞留——error 事件
// 按设计**不挡**重派（幂等哨只认非 error 的 terminal 事件），但此前没有任何重派入口。
//
// 用法：
//   pnpm quiz:reverify <question_id...>   # 显式 id 列表
//   pnpm quiz:reverify --error-only       # 自动找「只有 error verify 事件」的 quiz_gen draft
//   pnpm quiz:reverify --dry-run ...      # 只报告不重派
//
// 每 id 前置校验（与 runQuizVerify 内哨同款，双重保护）：存在 + source='quiz_gen' +
// draft_status='draft' + 无非 error 的 verify 事件。不合格的 id 报告 skipped 不入队。
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { event, question } from '@/db/schema';

interface Disposition {
  id: string;
  action: 'enqueued' | 'skipped';
  reason?: string;
}

async function findErrorOnlyDrafts(): Promise<string[]> {
  // 所有 quiz_gen draft，逐一看 verify 事件面：有任何非 error 事件 → 已 terminal，跳过。
  const drafts = await db
    .select({ id: question.id })
    .from(question)
    .where(and(eq(question.source, 'quiz_gen'), eq(question.draft_status, 'draft')));
  const out: string[] = [];
  for (const row of drafts) {
    const terminal = await db
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:quiz_verify'),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, row.id),
          ne(event.outcome, 'error'),
        ),
      )
      .limit(1);
    const anyVerify = await db
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:quiz_verify'),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, row.id),
        ),
      )
      .limit(1);
    // 只有 error 事件（或零事件但明确滞留）才重派。
    if (terminal.length === 0 && anyVerify.length > 0) out.push(row.id);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const errorOnly = argv.includes('--error-only');
  const ids = argv.filter((a) => !a.startsWith('--'));

  const candidates = errorOnly ? await findErrorOnlyDrafts() : ids;
  if (candidates.length === 0) {
    console.log('[quiz:reverify] 无候选（--error-only 未发现 stranded draft，或未给 id）');
    return;
  }

  const dispositions: Disposition[] = [];
  const enqueueIds: string[] = [];
  for (const id of candidates) {
    const rows = await db
      .select({ id: question.id, source: question.source, draft_status: question.draft_status })
      .from(question)
      .where(eq(question.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      dispositions.push({ id, action: 'skipped', reason: 'not_found' });
      continue;
    }
    if (row.source !== 'quiz_gen') {
      dispositions.push({
        id,
        action: 'skipped',
        reason: `source=${row.source}（仅 quiz_gen 走此链）`,
      });
      continue;
    }
    if (row.draft_status !== 'draft') {
      dispositions.push({
        id,
        action: 'skipped',
        reason: `draft_status=${row.draft_status}（非 draft 不重派）`,
      });
      continue;
    }
    const terminal = await db
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:quiz_verify'),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, id),
          ne(event.outcome, 'error'),
        ),
      )
      .limit(1);
    if (terminal.length > 0) {
      dispositions.push({
        id,
        action: 'skipped',
        reason: '已有 terminal verify 事件（幂等哨会跳）',
      });
      continue;
    }
    enqueueIds.push(id);
    dispositions.push({ id, action: 'enqueued' });
  }

  if (enqueueIds.length > 0 && !dryRun) {
    const { getStartedBoss } = await import('@/server/boss/client');
    const boss = await getStartedBoss();
    const jobId = await boss.send('quiz_verify', { question_ids: enqueueIds });
    console.log(`[quiz:reverify] quiz_verify job 已派：${jobId}（${enqueueIds.length} 题）`);
  }

  for (const d of dispositions) {
    console.log(
      `  ${d.action === 'enqueued' ? '✓' : '–'} ${d.id}  ${d.action}${d.reason ? `：${d.reason}` : ''}`,
    );
  }
  if (dryRun) console.log('[quiz:reverify] dry-run：未实际派发');
  process.exit(0);
}

main().catch((err) => {
  console.error('[quiz:reverify] 失败：', err);
  process.exit(1);
});
