import type { Db } from '@/db/client';
import { getR2 } from '@/server/r2';
import type { PgBoss } from 'pg-boss';
import { buildEchoHandler } from './handlers/echo';
import { buildKnowledgePropoNightlyHandler } from './handlers/knowledge_propose_nightly';
import { buildPruneJobEventsHandler } from './handlers/prune_job_events';
import { buildTencentOcrHandler } from './handlers/tencent_ocr_extract';

/**
 * Register all pg-boss queue handlers + schedules.
 *
 * 在 worker entrypoint 启动时调一次（Step 14）。
 *   - Step 4 ✓: echo (golden E2E)
 *   - Step 5 ✓: knowledge_propose_nightly + prune_job_events (cron)
 *   - Step 9 ✓: tencent_ocr_extract (生产 OCR async job)
 */
export async function registerHandlers(boss: PgBoss, db: Db): Promise<void> {
  // Step 4: echo golden E2E queue
  await boss.createQueue('echo');
  await boss.work('echo', { pollingIntervalSeconds: 0.5, batchSize: 1 }, buildEchoHandler(db));

  // Step 5: nightly cron tasks
  await boss.createQueue('knowledge_propose_nightly');
  await boss.work('knowledge_propose_nightly', buildKnowledgePropoNightlyHandler(db));
  await boss.createQueue('prune_job_events');
  await boss.work('prune_job_events', buildPruneJobEventsHandler(db));
  await boss.schedule('knowledge_propose_nightly', '0 2 * * *', {}, { tz: 'Asia/Shanghai' });
  await boss.schedule('prune_job_events', '0 4 * * *', {}, { tz: 'Asia/Shanghai' });

  // Step 9: Tencent OCR Mark Agent —— 生产 async job
  // R2 in worker process needs env config; getR2() throws if missing — call inside
  // handler factory so missing creds don't break test worker setup.
  await boss.createQueue('tencent_ocr_extract');
  await boss.work(
    'tencent_ocr_extract',
    { pollingIntervalSeconds: 0.5, batchSize: 1 },
    buildTencentOcrHandler({
      db,
      // lazy r2 —— test 环境通过 R2 env 未设也能起 worker；生产 env 必须齐全
      get r2() {
        return getR2();
      },
    } as Parameters<typeof buildTencentOcrHandler>[0]),
  );
}
