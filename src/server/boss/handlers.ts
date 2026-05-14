import type { PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import { buildEchoHandler } from './handlers/echo';
import { buildKnowledgePropoNightlyHandler } from './handlers/knowledge_propose_nightly';
import { buildPruneJobEventsHandler } from './handlers/prune_job_events';

/**
 * Register all pg-boss queue handlers + schedules.
 *
 * 在 worker entrypoint 启动时调一次（Step 14）。
 *   - Step 4 ✓: echo (golden E2E)
 *   - Step 5 ✓: knowledge_propose_nightly + prune_job_events (cron)
 *   - Step 9: tencent_ocr_extract (生产 OCR async job)
 */
export async function registerHandlers(boss: PgBoss, db: Db): Promise<void> {
  // Step 4: echo golden E2E queue
  // pollingIntervalSeconds=0.5 (pg-boss enforced min)；prod 默认 2s
  await boss.createQueue('echo');
  await boss.work('echo', { pollingIntervalSeconds: 0.5, batchSize: 1 }, buildEchoHandler(db));

  // Step 5: nightly cron tasks
  await boss.createQueue('knowledge_propose_nightly');
  await boss.work('knowledge_propose_nightly', buildKnowledgePropoNightlyHandler(db));
  await boss.createQueue('prune_job_events');
  await boss.work('prune_job_events', buildPruneJobEventsHandler(db));

  // Schedule: 北京 02:00 = UTC 18:00 前一日；用 tz 让 pg-boss 处理
  await boss.schedule('knowledge_propose_nightly', '0 2 * * *', {}, { tz: 'Asia/Shanghai' });
  // Prune at 04:00 BJT
  await boss.schedule('prune_job_events', '0 4 * * *', {}, { tz: 'Asia/Shanghai' });

  // Step 9+ 在此追加：
  //   await boss.createQueue('tencent_ocr_extract');
  //   await boss.work('tencent_ocr_extract', { teamSize: 1 }, buildTencentOcrHandler(db));
}
