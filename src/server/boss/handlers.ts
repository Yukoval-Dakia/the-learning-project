import { buildAutoEnrollHandler } from '@/capabilities/ingestion/jobs/auto_enroll';
import { buildTencentOcrHandler } from '@/capabilities/ingestion/jobs/tencent_ocr_extract';
import { buildNoteGenerateHandler } from '@/capabilities/notes/jobs/note_generate';
import { buildNoteVerifyHandler } from '@/capabilities/notes/jobs/note_verify';
import type { Db } from '@/db/client';
import {
  EXPIRE_AGENT,
  EXPIRE_LLM,
  FAST_QUEUE_OPTS,
  createJobQueue,
  createOrUpdateQueue,
} from '@/server/boss/queue-config';
import { buildBriefGenerator } from '@/server/memory/brief-writer';
import { registerMemoryHandlers } from '@/server/memory/triggers';
import { getR2 } from '@/server/r2';
import type { PgBoss } from 'pg-boss';
import { buildEchoHandler } from './handlers/echo';
import { buildEmbeddedCheckGenerateHandler } from './handlers/embedded_check_generate';
import { buildPromoteConversationIdleHandler } from './handlers/promote_conversation_idle';
import { buildPruneJobEventsHandler } from './handlers/prune_job_events';
import { buildPruneOrphanConversationSessionsHandler } from './handlers/prune_orphan_conversation_sessions';
import { buildPruneOrphanReviewSessionsHandler } from './handlers/prune_orphan_review_sessions';
import { buildQuizGenHandler } from './handlers/quiz_gen';
import { buildQuizVerifyHandler } from './handlers/quiz_verify';
import { buildSessionSummaryHandler } from './handlers/session_summary';
import { buildSourceVerifyHandler } from './handlers/source_verify';
import { buildSourcingHandler } from './handlers/sourcing';
import { buildVariantGenHandler } from './handlers/variant_gen';
import { buildVariantVerifyHandler } from './handlers/variant_verify';

// M4-T3 (YUK-319)：本文件已渐缩为「未迁域 job 注册簿」。建队配方（YUK-237 三档
// expire/retention/DLQ + YUK-259 race 防护）抽到 queue-config.ts，与 capability
// jobs 注册器（register-capability-jobs.ts）共用。已迁入 manifest jobs 声明并由
// 注册器挂载的 job 不再出现在这里：knowledge 夜链三 cron + attribution_followup、
// notes 的 hub_auto_sync_nightly + note_refine、practice 的 review_plan、agency
// 四 cron（dreaming/coach_daily/coach_weekly/goal_scope）。
//
// 仍留簿的注册（M5 拆除采石场时清账）：
//   - echo（golden E2E，0.5s polling）
//   - rejudge（非默认 1s polling + inline 动态 import，非工厂形态）
//   - prune_job_events / prune_orphan_* / promote_conversation_idle（FAST housekeeping cron）
//   - registerMemoryHandlers（memory_* 队列归 memory 模块）
//   - session_summary / embedded_check_generate（链式 LLM）
//   - note_verify / note_generate（工厂带 boss 二参链式回调，不符 JobHandlerFactory 单参签名）
//   - quiz_gen / quiz_verify / sourcing / source_verify / variant_gen / variant_verify
//   - tencent_ocr_extract（0.5s polling + lazy r2 getter）/ auto_enroll
//   - 未迁域：ingestion（auto_enroll / tencent_ocr_extract 待 ingestion 包 jobs 声明）

/**
 * Register pg-boss queue handlers + schedules for jobs NOT yet owned by a
 * capability manifest（渐缩簿）。
 *
 * 在 worker entrypoint 启动时调一次（start-worker.ts），随后必须紧跟
 * registerCapabilityJobs 挂载各包声明的 job。
 */
export async function registerHandlers(boss: PgBoss, db: Db): Promise<void> {
  // Step 4: echo golden E2E queue (FAST — trivial round-trip)
  await createOrUpdateQueue(boss, 'echo', FAST_QUEUE_OPTS);
  await boss.work('echo', { pollingIntervalSeconds: 0.5, batchSize: 1 }, buildEchoHandler(db));

  // M2 (YUK-316, D15) — 申诉自动重判。appeal API 投递（singletonKey=appeal
  // event id）；handler 本体在 practice capability 包，manifest 声明无 load
  // （注册形态是非默认 1s polling + inline 动态 import，非工厂，不走注册器
  // 统一配方）——注册留簿，M5 清账。
  await createJobQueue(boss, 'rejudge', EXPIRE_LLM);
  await boss.work('rejudge', { pollingIntervalSeconds: 1, batchSize: 1 }, async (jobs) => {
    const { handleRejudge } = await import('@/capabilities/practice/jobs/rejudge');
    for (const job of jobs) {
      await handleRejudge(db, job.data as { appeal_event_id: string });
    }
  });

  // Step 5: nightly housekeeping cron（同区段的 knowledge_propose_nightly 已迁
  // knowledge manifest jobs 声明，由注册器挂载）
  await createOrUpdateQueue(boss, 'prune_job_events', FAST_QUEUE_OPTS); // FAST — bulk DELETE housekeeping, re-runs next cron
  await boss.work('prune_job_events', buildPruneJobEventsHandler(db));
  await boss.schedule('prune_job_events', '0 4 * * *', {}, { tz: 'Asia/Shanghai' });

  // T-37 / YUK-185: Mem0 fact ingest + per-scope brief regen queues. Station 2A
  // injects the real brief writer (buildBriefGenerator) so the regen pipeline
  // produces memory_brief_note rows instead of falling back to the throwing
  // defaultGenerateBrief (triggers.ts). I-1: was a stale `YUK-37` comment — this
  // wiring is YUK-185 / T-37.
  await registerMemoryHandlers(boss, db, { generateBrief: buildBriefGenerator({ db }) });

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
