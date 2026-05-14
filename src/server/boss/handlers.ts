import type { PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import { buildEchoHandler } from './handlers/echo';

/**
 * Register all pg-boss queue handlers + schedules.
 *
 * 在 worker entrypoint 启动时调一次（Step 14）；handlers 自身实现在 Step 4-9 + 13 完成：
 *   - Step 4 ✓: echo (golden E2E)
 *   - Step 5: knowledge_propose_nightly + prune_job_events (cron)
 *   - Step 9: tencent_ocr_extract (生产 OCR async job)
 */
export async function registerHandlers(boss: PgBoss, db: Db): Promise<void> {
  // Step 4: echo golden E2E queue
  // pollingIntervalSeconds=0.5 (pg-boss enforced min)；prod 默认 2s
  await boss.createQueue('echo');
  await boss.work('echo', { pollingIntervalSeconds: 0.5, batchSize: 1 }, buildEchoHandler(db));

  // Step 5+ 在此追加：
  //   await boss.createQueue('tencent_ocr_extract');
  //   await boss.work('tencent_ocr_extract', { teamSize: 1 }, buildTencentOcrHandler(db));
}
