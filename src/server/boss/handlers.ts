import type { Db } from '@/db/client';
import { isQueueCreateRace } from '@/server/boss/client';
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
import { buildQuizGenHandler } from './handlers/quiz_gen';
import { buildQuizVerifyHandler } from './handlers/quiz_verify';
import { buildReviewPlanHandler } from './handlers/review_plan';
import { buildSessionSummaryHandler } from './handlers/session_summary';
import { buildSourceVerifyHandler } from './handlers/source_verify';
import { buildSourcingHandler } from './handlers/sourcing';
import { buildTencentOcrHandler } from './handlers/tencent_ocr_extract';
import { buildVariantGenHandler } from './handlers/variant_gen';
import { buildVariantVerifyHandler } from './handlers/variant_verify';

// YUK-237 [STB-3]: per-queue expiration / retention / dead-letter config.
//
// Background: pg-boss v12 sets these at the QUEUE level (createQueue options),
// inherited by each job. Defaults are `expireInSeconds: 900` (15 min — a job is
// retried/failed if it stays active longer) and `retentionSeconds: 1209600`
// (14 days a created/retry job survives before deletion). The 15-min active
// ceiling is too tight for our long tool-calling LLM jobs (quiz_gen / sourcing /
// dreaming can run multi-step agent loops), so an over-running job was being
// silently retried mid-flight. We raise expiry per workload tier and add a
// dead-letter queue for the expensive LLM producers so a job that exhausts its
// retries is preserved for inspection instead of vanishing.
//
// Tiers (expireInSeconds is the max time a job may stay `active`):
//   FAST  — sub-second housekeeping (echo / prune_* / promote_idle). Brief floor
//           of 1h is overkill for these but keeps a single safe minimum.
//   LLM   — single ~30-90s LLM call handlers (note_*, variant_*, coach_*,
//           session_summary, embedded_check, attribution_followup, review_plan,
//           goal_scope, hub_auto_sync, auto_enroll). 1h ceiling.
//   AGENT — multi-step tool-calling agents that can legitimately run for many
//           minutes (quiz_gen / quiz_verify / sourcing / source_verify /
//           dreaming_nightly / knowledge_maintenance / tencent_ocr). 2h ceiling.
//
// retentionSeconds: 7 days everywhere (brief floor; below the 14-day default so
// we don't keep stuck created/retry jobs around for two weeks).
//
// Dead-letter: only the AGENT + LLM producers route exhausted jobs to
// `<queue>_dlq`. We create the DLQ first (createQueue is idempotent on name) so
// the failed payload lands somewhere queryable. FAST housekeeping queues skip
// the DLQ — a dropped prune tick just re-runs on the next cron.
const RETENTION_7D = 604_800; // 7 days, brief floor
const EXPIRE_FAST = 3_600; // 1h — brief minimum floor for cheap jobs
const EXPIRE_LLM = 3_600; // 1h — single LLM call handlers
const EXPIRE_AGENT = 7_200; // 2h — multi-step tool-calling agent loops

const FAST_QUEUE_OPTS = {
  expireInSeconds: EXPIRE_FAST,
  retentionSeconds: RETENTION_7D,
} as const;

/**
 * Build createQueue options for an LLM/agent queue, wiring a dead-letter queue.
 * Caller MUST create the returned `deadLetter` queue first (see createJobQueue).
 */
function jobQueueOpts(queueName: string, expireInSeconds: number) {
  return {
    expireInSeconds,
    retentionSeconds: RETENTION_7D,
    deadLetter: `${queueName}_dlq`,
  } as const;
}

/**
 * Create a queue AND reconcile its config if it already exists.
 *
 * pg-boss `createQueue` is `INSERT ... ON CONFLICT DO NOTHING` (plans.js
 * `create_queue` plpgsql) — on an upgrade where the queue was already created by
 * an older worker, it leaves the *old* expire/retention/dead-letter untouched.
 * That silently no-ops the YUK-237 stability tuning on every existing prod DB
 * (the only DBs that matter for a long-running NAS worker). `updateQueue` runs
 * `UPDATE ${schema}.queue SET expire_seconds/retention_seconds/dead_letter ...
 * WHERE name = $1` (plans.js `updateQueue`), so calling it right after
 * createQueue forces the live config onto both brand-new and pre-existing
 * queues. On a fresh queue updateQueue is a harmless self-update; on a missing
 * queue it is a no-op UPDATE (0 rows) — but we always createQueue first, so the
 * row exists. Keeping the SAME opts object for both calls keeps them in lockstep.
 *
 * YUK-259: concurrency-safe. When the app's in-process boss (instrumentation,
 * getStartedBoss) and the worker both register/start against the same DB during
 * a cold start, pg-boss's queue INSERT can race past its own ON CONFLICT and
 * raise a 23505 `queue_pkey` violation (observed repeatedly in the test env —
 * worker crashed in registration with `Key (name)=(...) already exists`). A
 * 23505 here means the queue already exists, which is the desired end state, so
 * we swallow it and STILL run `updateQueue` — the reconcile that lands the
 * YUK-237 config onto the (now confirmed-existing) row. #329 semantics are
 * preserved: an already-existing queue still gets the new config. Any other
 * error is re-thrown.
 */
async function createOrUpdateQueue(
  boss: PgBoss,
  name: string,
  opts: { expireInSeconds: number; retentionSeconds: number; deadLetter?: string },
): Promise<void> {
  try {
    await boss.createQueue(name, opts);
  } catch (err) {
    if (!isQueueCreateRace(err)) throw err;
    // Benign create race — the queue row exists; fall through to updateQueue so
    // the YUK-237 config still gets reconciled onto it.
    console.warn(
      `[boss] createQueue('${name}') hit a concurrent create race (23505 queue_pkey) — queue already exists, reconciling config (YUK-259)`,
    );
  }
  await boss.updateQueue(name, opts);
}

/**
 * Create an LLM/agent producer queue together with its dead-letter queue.
 *
 * Order matters: the DLQ must exist before the main queue references it as
 * `deadLetter`. createQueue is idempotent on name, so re-running registration is
 * safe; createOrUpdateQueue additionally reconciles config onto an existing
 * queue (see its docblock — required so YUK-237 tuning lands on upgraded prod
 * DBs, not just fresh ones). The DLQ itself uses FAST opts (7-day retention, 1h
 * expire) — it only holds inert failed payloads, never runs a worker.
 */
async function createJobQueue(boss: PgBoss, name: string, expireInSeconds: number): Promise<void> {
  await createOrUpdateQueue(boss, `${name}_dlq`, FAST_QUEUE_OPTS);
  await createOrUpdateQueue(boss, name, jobQueueOpts(name, expireInSeconds));
}

/**
 * Register all pg-boss queue handlers + schedules.
 *
 * 在 worker entrypoint 启动时调一次（Step 14）。
 *   - Step 4 ✓: echo (golden E2E)
 *   - Step 5 ✓: knowledge_propose_nightly + prune_job_events (cron)
 *   - Step 9 ✓: tencent_ocr_extract (生产 OCR async job)
 *   - Phase 2 ✓: knowledge_edge_propose_nightly (cron — dreaming mesh)
 *
 * YUK-237: every createQueue below now carries explicit expire/retention (and a
 * dead-letter queue for the LLM/agent producers) — see the tier constants above.
 */
export async function registerHandlers(boss: PgBoss, db: Db): Promise<void> {
  // Step 4: echo golden E2E queue (FAST — trivial round-trip)
  await createOrUpdateQueue(boss, 'echo', FAST_QUEUE_OPTS);
  await boss.work('echo', { pollingIntervalSeconds: 0.5, batchSize: 1 }, buildEchoHandler(db));

  // Step 5: nightly cron tasks
  await createJobQueue(boss, 'knowledge_propose_nightly', EXPIRE_LLM);
  await boss.work('knowledge_propose_nightly', buildKnowledgePropoNightlyHandler(db));
  await createOrUpdateQueue(boss, 'prune_job_events', FAST_QUEUE_OPTS); // FAST — bulk DELETE housekeeping, re-runs next cron
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
  await createJobQueue(boss, 'knowledge_edge_propose_nightly', EXPIRE_LLM);
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
  await createJobQueue(boss, 'hub_auto_sync_nightly', EXPIRE_LLM);
  await boss.work(
    'hub_auto_sync_nightly',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildHubAutoSyncNightlyHandler(db),
  );
  await boss.schedule('hub_auto_sync_nightly', '45 2 * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-48: broader KnowledgeReviewTask maintenance producer (BJT 03:00,
  // after the cheaper node/edge structured-output proposers).
  await createJobQueue(boss, 'knowledge_maintenance_nightly', EXPIRE_AGENT);
  await boss.work(
    'knowledge_maintenance_nightly',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildKnowledgeMaintenanceNightlyHandler(db),
  );
  await boss.schedule('knowledge_maintenance_nightly', '0 3 * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-114 / T-DR: bounded Dreaming producer using DomainTool MCP bridge.
  // Runs after cheaper graph maintenance so it can see same-night proposal state.
  await createJobQueue(boss, 'dreaming_nightly', EXPIRE_AGENT);
  await boss.work(
    'dreaming_nightly',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildDreamingNightlyHandler(db),
  );
  await boss.schedule('dreaming_nightly', '15 3 * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-203 U4 / D5: review_plan — the tactical ReviewPlanTask queue. Registered
  // BEFORE coach_daily so the worker is ready to accept the chained
  // coach_daily → review_plan send (buildCoachDailyHandler enqueues it after a
  // successful coach run; runtime map bullet 4). NO `schedule` — it is
  // chain-triggered (and on-demand re-run), NOT a cron (D5:29 "不要另开独立 cron").
  await createJobQueue(boss, 'review_plan', EXPIRE_LLM);
  await boss.work(
    'review_plan',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildReviewPlanHandler(db),
  );

  // Wave 5 / T-D6/B (YUK-119): coach_daily + coach_weekly.
  // coach_daily runs nightly at BJT 03:45 — 30 min after dreaming_nightly
  // (`15 3 * * *`) so Coach can read Dreaming's same-night proposals, and
  // 15 min before prune_job_events (`0 4 * * *`) to avoid IO contention with
  // the bulk DELETE pass. coach_weekly runs Sunday BJT 04:30 to produce the
  // weekly_reflection slot in TodayPlan (after the prune storm settles).
  await createJobQueue(boss, 'coach_daily', EXPIRE_LLM);
  await boss.work(
    'coach_daily',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildCoachDailyHandler(db),
  );
  await boss.schedule('coach_daily', '45 3 * * *', {}, { tz: 'Asia/Shanghai' });

  await createJobQueue(boss, 'coach_weekly', EXPIRE_LLM);
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
  await createJobQueue(boss, 'goal_scope_propose_nightly', EXPIRE_LLM);
  await boss.work(
    'goal_scope_propose_nightly',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildGoalScopeProposeNightlyHandler(db),
  );
  await boss.schedule('goal_scope_propose_nightly', '50 3 * * *', {}, { tz: 'Asia/Shanghai' });

  // ADR-0013: abandon review sessions stuck in 'started' >6h (sendBeacon
  // fallback when normal close didn't fire). BJT 04:15 after prune_job_events.
  await createOrUpdateQueue(boss, 'prune_orphan_review_sessions', FAST_QUEUE_OPTS); // FAST — cheap SELECT + per-row transition
  await boss.work('prune_orphan_review_sessions', buildPruneOrphanReviewSessionsHandler(db));
  await boss.schedule('prune_orphan_review_sessions', '15 4 * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-14 (docs/design/2026-05-24-teaching-idle-state-machine.md): promote
  // active conversation sessions to 'idle' after 5min of no user input.
  // Runs every minute; cheap SELECT + per-row single-owner transition.
  await createOrUpdateQueue(boss, 'promote_conversation_idle', FAST_QUEUE_OPTS); // FAST — every-minute cheap SELECT
  await boss.work('promote_conversation_idle', buildPromoteConversationIdleHandler(db));
  await boss.schedule('promote_conversation_idle', '* * * * *', {}, { tz: 'Asia/Shanghai' });

  // YUK-14: abandon conversation sessions stuck in 'active'|'idle' >6h
  // (sendBeacon fallback). BJT 04:25, offset 10min from review prune to
  // avoid lock contention on learning_session.
  await createOrUpdateQueue(boss, 'prune_orphan_conversation_sessions', FAST_QUEUE_OPTS); // FAST — cheap SELECT + per-row transition
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
  await createJobQueue(boss, 'session_summary', EXPIRE_LLM);
  await boss.work(
    'session_summary',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildSessionSummaryHandler(db),
  );

  // Product Track 1: EmbeddedCheckGenerateTask — chained behind note_verify so
  // that only verified notes spend LLM tokens on inline self-test generation.
  await createJobQueue(boss, 'embedded_check_generate', EXPIRE_LLM);
  await boss.work(
    'embedded_check_generate',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildEmbeddedCheckGenerateHandler(db),
  );

  // Search-grounded QuizGen (T-SQ, docs/superpowers/specs/2026-06-02-quizgen-
  // search-grounded-design.md §3 / §4). Manual-first: enqueued by
  // POST /api/questions/quiz-gen (Q4). The tool-calling QuizGenTask agent mounts
  // the Tavily remote MCP (env-gated) + the in-process domain-tool MCP, writes
  // draft questions (Option B: draft_status='draft', NOT in the pool), then
  // chains a quiz_verify job { question_ids }. batchSize=1 keeps mimo
  // rate-limit friendly.
  //
  await createJobQueue(boss, 'quiz_gen', EXPIRE_AGENT);
  await boss.work('quiz_gen', { pollingIntervalSeconds: 2, batchSize: 1 }, buildQuizGenHandler(db));

  // Q5 + Q6 (same wave §3 / §5): QuizVerifyTask — chained behind quiz_gen, which
  // sends `quiz_verify` { question_ids } after writing draft questions. The
  // single-shot CLOSED-BOOK verifier runs the 3 checks (grounding / copy_safety /
  // knowledge-hit) + a deterministic n-gram overlap, then gates Option B: on pass
  // it promotes draft_status 'draft'→'active' AND FSRS-enrolls the question
  // (initial material_fsrs_state via the single-owner enroll path) so it enters
  // the review pool; on needs_review / fail / too_close the draft stays out of the
  // pool. Idempotent per question via the chained verify event guard.
  // batchSize=1 keeps mimo rate-limit friendly.
  await createJobQueue(boss, 'quiz_verify', EXPIRE_AGENT);
  await boss.work(
    'quiz_verify',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildQuizVerifyHandler(db),
  );

  // YUK-216 S2 slice 2 (题源扩展 Strategy D, docs/superpowers/plans/2026-06-05-
  // yuk216-question-source-s2.md §3): the online sourcing line. SourcingTask
  // searches the web for EXISTING practice questions, restructures each into a
  // draft (source='web_sourced', tier 2, draft_status='draft' — NOT in the pool),
  // then chains a source_verify job { question_ids }. Mirrors quiz_gen → quiz_verify.
  // batchSize=1 keeps mimo rate-limit friendly.
  await createJobQueue(boss, 'sourcing', EXPIRE_AGENT);
  await boss.work(
    'sourcing',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildSourcingHandler(db),
  );

  // source_verify — chained behind sourcing. Runs the tier-2 check set
  // (structure_completeness + source_consistency + solve_check + dedup, from
  // verify-framework.ts) and gates Option B: pass → promote draft→active +
  // FSRS-enroll (enters the review pool); fail → stays draft. Idempotent per
  // question via the chained verify event guard. batchSize=1 keeps mimo
  // rate-limit friendly.
  await createJobQueue(boss, 'source_verify', EXPIRE_AGENT);
  await boss.work(
    'source_verify',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildSourceVerifyHandler(db),
  );

  // Product Track 1: NoteVerifyTask — enqueued after note_generate marks a
  // generated note ready. Keeps note generation and verification as separate
  // lifecycle axes.
  await createJobQueue(boss, 'note_verify', EXPIRE_LLM);
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
  await createJobQueue(boss, 'note_generate', EXPIRE_LLM);
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
  await createJobQueue(boss, 'note_refine', EXPIRE_LLM);
  await boss.work(
    'note_refine',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildNoteRefineHandler(db),
  );

  // Task #16: async attribution for new failure attempts. Replaces the
  // inline `next/server.after()` call in /api/mistakes + /api/ingestion/[id]/
  // import. Worker process, durable, retryable.
  await createJobQueue(boss, 'attribution_followup', EXPIRE_LLM);
  await boss.work(
    'attribution_followup',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildAttributionFollowupHandler(db),
  );

  // Task #17: variant generation. Enqueued by attribution_followup after
  // a judge event is written; consumes ~30-60s LLM call to produce a 1-shot
  // variant question (mistakes spec §3.4). batchSize=1 keeps mimo
  // rate-limit friendly.
  await createJobQueue(boss, 'variant_gen', EXPIRE_LLM);
  await boss.work(
    'variant_gen',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildVariantGenHandler(db),
  );

  // YUK-17 / ADR-0018 — second-pass content alignment check for accepted
  // variants. Enqueued by acceptAiProposal after a variant_question proposal
  // is accepted; verdict='fail' flips mistake_variant.status to 'broken'.
  await createJobQueue(boss, 'variant_verify', EXPIRE_LLM);
  await boss.work(
    'variant_verify',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildVariantVerifyHandler(db),
  );

  // Step 9: Tencent OCR Mark Agent —— 生产 async job
  // R2 in worker process needs env config; getR2() throws if missing — call inside
  // handler factory so missing creds don't break test worker setup.
  await createJobQueue(boss, 'tencent_ocr_extract', EXPIRE_AGENT);
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
  await createJobQueue(boss, 'auto_enroll', EXPIRE_LLM);
  await boss.work(
    'auto_enroll',
    { pollingIntervalSeconds: 2, batchSize: 1 },
    buildAutoEnrollHandler(db),
  );
}
