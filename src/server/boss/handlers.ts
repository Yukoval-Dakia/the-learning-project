import type { Db } from '@/db/client';
import { getR2 } from '@/server/r2';
import type { PgBoss } from 'pg-boss';
import { buildAttributionFollowupHandler } from './handlers/attribution_followup';
import { buildEchoHandler } from './handlers/echo';
import { buildKnowledgeEdgeProposeNightlyHandler } from './handlers/knowledge_edge_propose_nightly';
import { buildKnowledgePropoNightlyHandler } from './handlers/knowledge_propose_nightly';
import { buildNoteGenerateHandler } from './handlers/note_generate';
import { buildPruneJobEventsHandler } from './handlers/prune_job_events';
import { buildPruneOrphanReviewSessionsHandler } from './handlers/prune_orphan_review_sessions';
import { buildSessionSummaryHandler } from './handlers/session_summary';
import { buildTencentOcrHandler } from './handlers/tencent_ocr_extract';

/**
 * Register all pg-boss queue handlers + schedules.
 *
 * 在 worker entrypoint 启动时调一次（Step 14）。
 *   - Step 4 ✓: echo (golden E2E)
 *   - Step 5 ✓: knowledge_propose_nightly + prune_job_events (cron)
 *   - Step 9 ✓: tencent_ocr_extract (生产 OCR async job)
 *   - Phase 2 ✓: knowledge_edge_propose_nightly (cron — dreaming mesh)
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

  // Phase 2 Dreaming: knowledge_edge mesh propose (BJT 02:30, after node propose)
  await boss.createQueue('knowledge_edge_propose_nightly');
  await boss.work('knowledge_edge_propose_nightly', buildKnowledgeEdgeProposeNightlyHandler(db));
  await boss.schedule('knowledge_edge_propose_nightly', '30 2 * * *', {}, { tz: 'Asia/Shanghai' });

  // ADR-0013: abandon review sessions stuck in 'started' >6h (sendBeacon
  // fallback when normal close didn't fire). BJT 04:15 after prune_job_events.
  await boss.createQueue('prune_orphan_review_sessions');
  await boss.work('prune_orphan_review_sessions', buildPruneOrphanReviewSessionsHandler(db));
  await boss.schedule('prune_orphan_review_sessions', '15 4 * * *', {}, { tz: 'Asia/Shanghai' });

  // Phase 1d: SessionSummaryTask — enqueued by /api/review/sessions/[id]/end
  // after a review session transitions to completed. async so the LLM call
  // doesn't block the close request.
  await boss.createQueue('session_summary');
  await boss.work(
    'session_summary',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildSessionSummaryHandler(db),
  );

  // Phase 2B: NoteGenerateTask — enqueued by /api/learning-intents/[id]/accept,
  // one job per atomic artifact. Each job runs ~30-60s LLM call and updates
  // the artifact row in place. batchSize=1 keeps mimo rate-limit friendly.
  await boss.createQueue('note_generate');
  await boss.work(
    'note_generate',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildNoteGenerateHandler(db),
  );

  // Task #16: async attribution for new failure attempts. Replaces the
  // inline `next/server.after()` call in /api/mistakes + /api/ingestion/[id]/
  // import. Worker process, durable, retryable.
  await boss.createQueue('attribution_followup');
  await boss.work(
    'attribution_followup',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildAttributionFollowupHandler(db),
  );

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
