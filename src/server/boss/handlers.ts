import type { Db } from '@/db/client';
import { buildBriefGenerator } from '@/server/memory/brief-writer';
import { registerMemoryHandlers } from '@/server/memory/triggers';
import { getR2 } from '@/server/r2';
import type { PgBoss } from 'pg-boss';
import { buildAttributionFollowupHandler } from './handlers/attribution_followup';
import { buildAutoEnrollHandler } from './handlers/auto_enroll';
import { buildCoachDailyHandler } from './handlers/coach_daily';
import { buildCoachWeeklyHandler } from './handlers/coach_weekly';
import { buildDreamingNightlyHandler } from './handlers/dreaming_nightly';
import { buildEchoHandler } from './handlers/echo';
import { buildEmbeddedCheckGenerateHandler } from './handlers/embedded_check_generate';
import { buildGoalScopeProposeNightlyHandler } from './handlers/goal_scope_propose_nightly';
import { buildHubAutoSyncNightlyHandler } from './handlers/hub_auto_sync_nightly';
import { buildKnowledgeEdgeProposeNightlyHandler } from './handlers/knowledge_edge_propose_nightly';
import { buildKnowledgeMaintenanceNightlyHandler } from './handlers/knowledge_maintenance_nightly';
import { buildKnowledgePropoNightlyHandler } from './handlers/knowledge_propose_nightly';
import { buildNoteRefineHandler } from './handlers/note-refine';
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

  // T-37 / YUK-185: Mem0 fact ingest + per-scope brief regen queues. Station 2A
  // injects the real brief writer (buildBriefGenerator) so the regen pipeline
  // produces memory_brief_note rows instead of falling back to the throwing
  // defaultGenerateBrief (triggers.ts). I-1: was a stale `YUK-37` comment — this
  // wiring is YUK-185 / T-37.
  await registerMemoryHandlers(boss, db, { generateBrief: buildBriefGenerator({ db }) });

  // Phase 2 Dreaming: knowledge_edge mesh propose (BJT 02:30, after node propose)
  await boss.createQueue('knowledge_edge_propose_nightly');
  await boss.work('knowledge_edge_propose_nightly', buildKnowledgeEdgeProposeNightlyHandler(db));
  await boss.schedule('knowledge_edge_propose_nightly', '30 2 * * *', {}, { tz: 'Asia/Shanghai' });

  // Wave 7 / YUK-95 P5 Lane-C: nightly hub auto-sync (ADR-0020 §9 iii-curated
  // mesh). Runs BJT 02:45 — 15 min AFTER knowledge_edge_propose_nightly
  // (`30 2 * * *`) so it sees the same-night fresh edges before recomputing each
  // hub's AutoLinksContainer auto-zone. Cross-process: relies on
  // persistNoteRefineApply's optimistic version lock, NOT the in-memory editing
  // heartbeat (Wave 7 D5).
  //
  // Concurrency: like every nightly here, this queue runs with pg-boss defaults
  // (localConcurrency 1, batchSize 1) and no `singleton` — a single worker
  // serializes runs within the process, so a scheduled fire won't overlap itself.
  // The version lock above is the cross-process safety net. Deliberately NOT
  // singling out this queue with a singleton the other nightlies don't use.
  await boss.createQueue('hub_auto_sync_nightly');
  await boss.work(
    'hub_auto_sync_nightly',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildHubAutoSyncNightlyHandler(db),
  );
  await boss.schedule('hub_auto_sync_nightly', '45 2 * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-48: broader KnowledgeReviewTask maintenance producer (BJT 03:00,
  // after the cheaper node/edge structured-output proposers).
  await boss.createQueue('knowledge_maintenance_nightly');
  await boss.work(
    'knowledge_maintenance_nightly',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildKnowledgeMaintenanceNightlyHandler(db),
  );
  await boss.schedule('knowledge_maintenance_nightly', '0 3 * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-114 / T-DR: bounded Dreaming producer using DomainTool MCP bridge.
  // Runs after cheaper graph maintenance so it can see same-night proposal state.
  await boss.createQueue('dreaming_nightly');
  await boss.work(
    'dreaming_nightly',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildDreamingNightlyHandler(db),
  );
  await boss.schedule('dreaming_nightly', '15 3 * * *', {}, { tz: 'Asia/Shanghai' });

  // Wave 5 / T-D6/B (YUK-119): coach_daily + coach_weekly.
  // coach_daily runs nightly at BJT 03:45 — 30 min after dreaming_nightly
  // (`15 3 * * *`) so Coach can read Dreaming's same-night proposals, and
  // 15 min before prune_job_events (`0 4 * * *`) to avoid IO contention with
  // the bulk DELETE pass. coach_weekly runs Sunday BJT 04:30 to produce the
  // weekly_reflection slot in TodayPlan (after the prune storm settles).
  await boss.createQueue('coach_daily');
  await boss.work(
    'coach_daily',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildCoachDailyHandler(db),
  );
  await boss.schedule('coach_daily', '45 3 * * *', {}, { tz: 'Asia/Shanghai' });

  await boss.createQueue('coach_weekly');
  await boss.work(
    'coach_weekly',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildCoachWeeklyHandler(db),
  );
  await boss.schedule('coach_weekly', '30 4 * * 0', {}, { tz: 'Asia/Shanghai' });

  // Station 2B / YUK-186: nightly goal-scope propose. Runs BJT 03:50 — AFTER
  // coach_daily (`45 3`) so it reads same-night materialized goals + active
  // subjects (steady by 03:50), and BEFORE prune_job_events (`0 4`) to avoid IO
  // contention with the bulk DELETE pass. Picks the single most-active subject
  // with ≥1 weak node and (cap=1) proposes at most one goal_scope into the
  // inbox; idempotent via gates on a live goal / pending proposal (subject_id).
  // Like every nightly here: defaults (localConcurrency 1, batchSize 1), no
  // singleton — a single worker serializes runs so a scheduled fire won't
  // overlap itself. The LLM call needs XIAOMI_API_KEY in the worker env (F-2).
  await boss.createQueue('goal_scope_propose_nightly');
  await boss.work(
    'goal_scope_propose_nightly',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildGoalScopeProposeNightlyHandler(db),
  );
  await boss.schedule('goal_scope_propose_nightly', '50 3 * * *', {}, { tz: 'Asia/Shanghai' });

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

  // Product Track 1: NoteVerifyTask — enqueued after note_generate marks a
  // generated note ready. Keeps note generation and verification as separate
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
  // one job per atomic/long artifact. Each job runs ~30-60s LLM call and updates
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

  // Wave 6 / T-88 P4-A (YUK-127): NoteRefineTask — Living Note refine pass.
  // Producers (P4-E, YUK-131) enqueue { artifact_id, trigger } when one of
  // the 5 trigger signals fires (mark_wrong / mastery_change / 错误率 /
  // dwell / dreaming). Handler loads context, calls NoteRefineTask, and
  // routes the resulting NotePatch to apply (mutator) or proposal (propose)
  // per the locked threshold `≤ 3 ops AND ≤ 2 new blocks → mutator`.
  //
  // PHASE-DEFERRED: P4-B (YUK-128) plugs the real gate + editing-session
  // deferral; P4-A ships mutator-only default so the apply path is wired.
  await boss.createQueue('note_refine');
  await boss.work(
    'note_refine',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildNoteRefineHandler(db),
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

  // Strategy D Slice B (YUK-190): observe-only auto-enroll. Enqueued inline by
  // tencent_ocr_extract after a successful extraction. With the enroll flag OFF
  // + observe ON (the default), it runs TaggingTask + WorkflowJudge per draft
  // block and writes a durable `experimental:auto_enroll_observed` audit event
  // per block (zero domain rows, blocks stay 'draft'). A cheap tagging job that
  // retries on its OWN queue — failure-isolated from the expensive OCR job.
  // batchSize=1 keeps mimo rate-limit friendly. The LLM call needs
  // XIAOMI_API_KEY in the worker env; a missing key routes each block to review
  // (no throw, no retry storm — handled per-block in the runner).
  await boss.createQueue('auto_enroll');
  await boss.work(
    'auto_enroll',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildAutoEnrollHandler(db),
  );
}
