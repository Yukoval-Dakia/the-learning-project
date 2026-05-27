import type { Db } from '@/db/client';
import { registerMemoryHandlers } from '@/server/memory/triggers';
import { getR2 } from '@/server/r2';
import type { PgBoss } from 'pg-boss';
import { buildAttributionFollowupHandler } from './handlers/attribution_followup';
import { buildEchoHandler } from './handlers/echo';
import { buildEmbeddedCheckGenerateHandler } from './handlers/embedded_check_generate';
import { buildKnowledgeEdgeProposeNightlyHandler } from './handlers/knowledge_edge_propose_nightly';
import { buildKnowledgeMaintenanceNightlyHandler } from './handlers/knowledge_maintenance_nightly';
import { buildKnowledgePropoNightlyHandler } from './handlers/knowledge_propose_nightly';
import { buildNoteGenerateHandler } from './handlers/note_generate';
import { buildNoteVerifyHandler } from './handlers/note_verify';
import { buildPromoteConversationIdleHandler } from './handlers/promote_conversation_idle';
import { buildPruneJobEventsHandler } from './handlers/prune_job_events';
import { buildPruneOrphanConversationSessionsHandler } from './handlers/prune_orphan_conversation_sessions';
import { buildPruneOrphanReviewSessionsHandler } from './handlers/prune_orphan_review_sessions';
import { buildSessionSummaryHandler } from './handlers/session_summary';
import { buildTencentOcrHandler } from './handlers/tencent_ocr_extract';
import { buildVariantGenHandler } from './handlers/variant_gen';
import { buildVariantVerifyHandler } from './handlers/variant_verify';

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

  // T-37 / YUK-37: Mem0 fact ingest + per-scope brief regen queues.
  await registerMemoryHandlers(boss, db);

  // Phase 2 Dreaming: knowledge_edge mesh propose (BJT 02:30, after node propose)
  await boss.createQueue('knowledge_edge_propose_nightly');
  await boss.work('knowledge_edge_propose_nightly', buildKnowledgeEdgeProposeNightlyHandler(db));
  await boss.schedule('knowledge_edge_propose_nightly', '30 2 * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-48: broader KnowledgeReviewTask maintenance producer (BJT 03:00,
  // after the cheaper node/edge structured-output proposers).
  await boss.createQueue('knowledge_maintenance_nightly');
  await boss.work(
    'knowledge_maintenance_nightly',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildKnowledgeMaintenanceNightlyHandler(db),
  );
  await boss.schedule('knowledge_maintenance_nightly', '0 3 * * *', {}, { tz: 'Asia/Shanghai' });

  // ADR-0013: abandon review sessions stuck in 'started' >6h (sendBeacon
  // fallback when normal close didn't fire). BJT 04:15 after prune_job_events.
  await boss.createQueue('prune_orphan_review_sessions');
  await boss.work('prune_orphan_review_sessions', buildPruneOrphanReviewSessionsHandler(db));
  await boss.schedule('prune_orphan_review_sessions', '15 4 * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-14 (docs/design/2026-05-24-teaching-idle-state-machine.md): promote
  // active conversation sessions to 'idle' after 5min of no user input.
  // Runs every minute; cheap SELECT + per-row single-owner transition.
  await boss.createQueue('promote_conversation_idle');
  await boss.work('promote_conversation_idle', buildPromoteConversationIdleHandler(db));
  await boss.schedule('promote_conversation_idle', '* * * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-14: abandon conversation sessions stuck in 'active'|'idle' >6h
  // (sendBeacon fallback). BJT 04:25, offset 10min from review prune to
  // avoid lock contention on learning_session.
  await boss.createQueue('prune_orphan_conversation_sessions');
  await boss.work(
    'prune_orphan_conversation_sessions',
    buildPruneOrphanConversationSessionsHandler(db),
  );
  await boss.schedule(
    'prune_orphan_conversation_sessions',
    '25 4 * * *',
    {},
    { tz: 'Asia/Shanghai' },
  );

  // Phase 1d: SessionSummaryTask — enqueued by /api/review/sessions/[id]/end
  // after a review session transitions to completed. async so the LLM call
  // doesn't block the close request.
  await boss.createQueue('session_summary');
  await boss.work(
    'session_summary',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildSessionSummaryHandler(db),
  );

  // Product Track 1: EmbeddedCheckGenerateTask — chained behind note_verify so
  // that only verified notes spend LLM tokens on inline self-test generation.
  await boss.createQueue('embedded_check_generate');
  await boss.work(
    'embedded_check_generate',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildEmbeddedCheckGenerateHandler(db),
  );

  // Product Track 1: NoteVerifyTask — enqueued after note_generate marks an
  // atomic note ready. Keeps note generation and verification as separate
  // lifecycle axes.
  await boss.createQueue('note_verify');
  await boss.work(
    'note_verify',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildNoteVerifyHandler(db, {
      onPassed: async (artifactId) => {
        await boss.send('embedded_check_generate', { artifact_id: artifactId });
      },
    }),
  );

  // Phase 2B: NoteGenerateTask — enqueued by /api/learning-intents/[id]/accept,
  // one job per atomic artifact. Each job runs ~30-60s LLM call and updates
  // the artifact row in place. batchSize=1 keeps mimo rate-limit friendly.
  await boss.createQueue('note_generate');
  await boss.work(
    'note_generate',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildNoteGenerateHandler(db, {
      onReady: async (artifactId) => {
        await boss.send('note_verify', { artifact_id: artifactId });
      },
    }),
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

  // Task #17: variant generation. Enqueued by attribution_followup after
  // a judge event is written; consumes ~30-60s LLM call to produce a 1-shot
  // variant question (mistakes spec §3.4). batchSize=1 keeps mimo
  // rate-limit friendly.
  await boss.createQueue('variant_gen');
  await boss.work(
    'variant_gen',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildVariantGenHandler(db),
  );

  // YUK-17 / ADR-0018 — second-pass content alignment check for accepted
  // variants. Enqueued by acceptAiProposal after a variant_question proposal
  // is accepted; verdict='fail' flips mistake_variant.status to 'broken'.
  await boss.createQueue('variant_verify');
  await boss.work(
    'variant_verify',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildVariantVerifyHandler(db),
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
