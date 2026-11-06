// YUK-1849 — dev-DB acceptance arc for the FINAL non-terminal-hold recovery
// design: the fingerprint gate is gone; any source_verify hold whose latest
// outcome is an error (config_error OR transient) is re-driven once per error
// epoch by the bounded sweep behind a zero-send lane preflight. A recovery
// intent carrying stale placement authority re-runs provenance-safe without it.
// Real dev Postgres rows and real lane machinery; the only fakes sit at the
// external boundary (provider call + image bytes + acquisition fetch), and the
// paid calls are counted at those seams. No pg-boss send, no real paid call.
//
// Each question is primed with the submission-time verify intent + completion so
// the sweep must take the recovery_epoch path (a completed original intent
// cannot re-dispatch; the latest error event is the epoch the sweep re-arms on).
//
// Run:
//   DATABASE_URL=postgres://loom_dev:loom_dev@127.0.0.1:5434/loom_dev_t3_5ba50596_acba784d \
//   OPENCODE_API_KEY=arc-dummy-a pnpm exec tsx scripts/tmp-yuk1849-config-error-arc.ts

import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AgentRunError } from '@/ai/agent-run-error';
import {
  assertSourceGroundingLaneConfigured,
  runSourceGroundingVerify,
} from '@/capabilities/practice/grading/server/judge/source-grounding-verify';
import type {
  RunTaskFn,
  SourceGroundingFn,
} from '@/capabilities/practice/question-bank/jobs/source_verify';
import {
  buildSourceVerifyHandler,
  runSourceVerify,
} from '@/capabilities/practice/question-bank/jobs/source_verify';
import { runServingAction } from '@/capabilities/practice/question-bank/server/serving-actions';
import {
  recoverOrphanVerifyDispatches,
  writeVerifyDispatchIntent,
} from '@/capabilities/practice/question-bank/server/verify-dispatch-outbox';
import type { RunWebFetchCandidatesResult } from '@/capabilities/practice/supply/server/web-candidates';
import {
  observeWebSuppliesForQuestion,
  placementWebDemandOutcome,
  runWebSupply,
} from '@/capabilities/practice/supply/server/web-supply';
import { canonicalHash } from '@/core/migration/canonical';
import type { SourcedQuestionT } from '@/core/schema/sourcing';
import { db } from '@/db/client';
import {
  event,
  placement_starter_attempt,
  placement_starter_attempt_question,
  placement_starter_claim,
  question,
  question_group_lifecycle,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events/index';
import type { PlacementVerificationAuthority } from '@/kernel/supply-contracts';
import { hydrateConfigFromDb } from '@/server/config/hydrate';
import { insertSourcedDraft } from '@/server/questions/sourced-draft-insert';
import { resolveSubjectProfile } from '@/subjects/profile';

const profile = resolveSubjectProfile(null);
const TAG = `arc${Date.now()}`;
let KID = `k-${TAG}`;
const evidence: Array<Record<string, unknown>> = [];
const ts = () => new Date().toISOString();
const note = (step: string, data: Record<string, unknown>) => {
  evidence.push({ ts: ts(), step, ...data });
  console.log(`[${ts()}] ${step}`, JSON.stringify(data));
};

const counts = { grounding: 0, solve: 0 };
const fakeImageFetch = async () => [
  { data: Buffer.from('arc-image-bytes').toString('base64'), mediaType: 'image/png' },
];
const solverOutput = (answer: string) =>
  JSON.stringify({ reference_solution: { final_answer: answer, answer_equivalents: [] } });
const groundingOutput = (grounded: boolean) =>
  JSON.stringify({
    grounded,
    confidence: 0.9,
    observed_md: '图中可见题干文字',
    reason_md: grounded ? '题面核心内容出现在来源图片中' : '题面内容与来源图片无关',
  });
const makeRunTask =
  (opts: { grounded?: boolean; answer?: string } = {}): RunTaskFn =>
  async (kind, input, ctx) => {
    await (
      ctx as { beforeProviderQuery?: (q: unknown) => Promise<void> } | undefined
    )?.beforeProviderQuery?.(input);
    if (kind === 'SourceGroundingVerifyTask') {
      counts.grounding += 1;
      return { text: groundingOutput(opts.grounded ?? true) };
    }
    counts.solve += 1;
    return { text: solverOutput(opts.answer ?? '代词') };
  };

interface SeedContent {
  prompt_md: string;
  reference_md: string;
  choices: string[];
  extract: string;
  answer: string;
}
const CONTENT: Record<string, SeedContent> = {
  zhi: {
    prompt_md: '「之」在「学而时习之」中作？',
    reference_md: '代词',
    choices: ['代词', '助词', '动词'],
    extract: '「之」在「学而时习之」中作代词，指代所学的内容。',
    answer: '代词',
  },
  hu: {
    prompt_md: '「乎」在「君子周而不比，小人比而不周乎」中作？',
    reference_md: '语气词',
    choices: ['语气词', '介词结构', '动词词尾'],
    extract: '「乎」在「君子周而不比，小人比而不周乎」句末作语气词，表示反问。',
    answer: '语气词',
  },
  yi: {
    prompt_md: '「矣」在「温故而知新，可以为师矣」中作？',
    reference_md: '句末语气词',
    choices: ['句末语气词', '连词', '实词'],
    extract: '「矣」在「温故而知新，可以为师矣」句末作语气词，表已然。',
    answer: '句末语气词',
  },
  ye: {
    prompt_md: '「也」在「仁者，人也」中作？',
    reference_md: '判断语气词',
    choices: ['判断语气词', '副词', '叹词'],
    extract: '「也」在「仁者，人也」句末作判断语气词，构成判断句。',
    answer: '判断语气词',
  },
};

// Topology writes are owned by the knowledge materialization projection — the
// arc hangs its candidate/claim rows on any existing approved KC instead.
async function seedKnowledge() {
  const rows = (await db.execute(
    sql`select id from knowledge where approval_status = 'approved' and archived_at is null order by created_at limit 1`,
  )) as unknown as Array<{ id: string }>;
  if (rows.length === 0) {
    throw new Error('arc requires an approved knowledge node in the dev db');
  }
  KID = rows[0].id;
}

async function seedQuestion(id: string, c: SeedContent) {
  const now = new Date();
  const url = `https://example.edu/wenyan/${id}`;
  const q: SourcedQuestionT = {
    kind: 'choice',
    prompt_md: `${c.prompt_md} arc marker ${TAG} alpha bravo charlie delta echo foxtrot`,
    reference_md: c.reference_md,
    choices_md: c.choices,
    judge_kind_override: 'exact',
    rubric_json: null,
    difficulty: 2,
    knowledge_ids: [KID],
    source_url: url,
    source_title: '论语 注疏',
    extract: `${c.extract} arc marker ${TAG} alpha bravo charlie delta echo foxtrot`,
  };
  await db.transaction(async (tx) => {
    // Registered converged writer: owns the content columns, mints the first
    // revision, and handles the canonical-hash dedup race.
    const result = await insertSourcedDraft(tx, {
      id,
      q,
      knowledgeIds: [KID],
      sourceRoute: 'sourcing_web',
      createdBy: { by: 'ai', task_kind: 'SourcingTask' },
      whitelistMatch: false,
      fetchedAt: '2026-06-06T00:00:00.000Z',
      canonicalContentHash: canonicalHash(`${id}:${TAG}:${c.prompt_md}`),
      mergeActorRef: 'sourcing',
      now,
    });
    if (result.status !== 'inserted') {
      throw new Error(`seed ${id} unexpectedly merged: ${JSON.stringify(result)}`);
    }
    // The grounding seam reads flags only the retired image_candidate path writes;
    // metadata is outside the content-writer audit's CONTENT_COLUMNS.
    await tx
      .update(question)
      .set({
        metadata: sql`metadata || ${JSON.stringify({
          source_ref_kind: 'url',
          single_source_grounding: true,
          image_candidate_source_asset_id: `asset-${id}`,
        })}::jsonb`,
      })
      .where(eq(question.id, id));
  });
}

/** The submission-time verify dispatch the pipeline already committed for this row. */
async function primeDispatch(qid: string, authority?: PlacementVerificationAuthority) {
  const intentId = await writeVerifyDispatchIntent(db, {
    questionId: qid,
    verifier: 'source_verify',
    ...(authority ? { placementAuthority: authority } : {}),
  });
  await writeEvent(db, {
    id: `arc-complete-${qid}`,
    actor_kind: 'system',
    actor_ref: 'verify_dispatch_outbox',
    action: 'experimental:verify_dispatch',
    subject_kind: 'question',
    subject_id: qid,
    outcome: 'success',
    payload: {
      version: 1,
      verifier_kind: 'source_verify',
      question_id: qid,
      stage: 'verify_enqueue',
      recovery: false,
      disposition: 'enqueued',
    },
    created_at: new Date(),
    ingest_at: new Date(),
  });
  return intentId;
}

const LANE_KEYS = [
  'task.SourceGroundingVerifyTask.provider',
  'task.SourceGroundingVerifyTask.model',
];

async function lane(mode: 'stale' | 'fixed') {
  if (mode === 'stale') {
    await db.execute(sql`
      insert into system_config (key, value, revision, updated_by, created_at, updated_at)
      values
        ('task.SourceGroundingVerifyTask.provider', '"xiaomi"'::jsonb, 1, 'yuk1849-arc', now(), now()),
        ('task.SourceGroundingVerifyTask.model', '"arc-stale-model"'::jsonb, 1, 'yuk1849-arc', now(), now())
      on conflict (key) do update set value = excluded.value, revision = system_config.revision + 1,
        updated_by = 'yuk1849-arc', updated_at = now()
    `);
  } else {
    await db.execute(
      sql`delete from system_config where key in (${sql.join(
        LANE_KEYS.map((k) => sql`${k}`),
        sql`, `,
      )})`,
    );
  }
  // Raw row edits bypass the writer path: bump the epoch ourselves or the in-process
  // hydration snapshot stays stale (epochUnchanged → outcome 'unchanged').
  await db.execute(sql`update system_config_epoch set epoch = epoch + 1, updated_at = now()`);
  const report = await hydrateConfigFromDb(db);
  note(`lane:${mode}`, { hydrate: report });
}

const groundingSeam = (grounded: boolean, answer: string): SourceGroundingFn => {
  const runTask = makeRunTask({ grounded, answer });
  return (p) =>
    runSourceGroundingVerify({ ...p, runTaskFn: runTask, imageFetchFn: fakeImageFetch });
};

/** A 429 at the provider call: the seam is reached (paid attempt) but the
 * provider answered transient-failed, so the run holds and throws for retry. */
const transientGroundingSeam = (): SourceGroundingFn => {
  return async () => {
    counts.grounding += 1;
    throw new AgentRunError({
      kind: 'SourceGroundingVerifyTask',
      taskRunId: `arc-tr-${TAG}`,
      subtype: 'api_error_result',
      apiErrorStatus: 429,
      errors: ['arc: simulated rate limit'],
    });
  };
};

async function deliver(
  qid: string,
  opts: {
    grounded?: boolean;
    answer?: string;
    commandEventId?: string;
    deliveryId?: string;
    transient?: boolean;
  } = {},
) {
  const grounded = opts.grounded ?? true;
  const answer = opts.answer ?? '代词';
  return runSourceVerify({
    db,
    questionId: qid,
    runTaskFn: makeRunTask({ grounded, answer }),
    imageFetchFn: fakeImageFetch,
    sourceGroundingPreflightFn: (i) => assertSourceGroundingLaneConfigured(i),
    sourceGroundingFn: opts.transient ? transientGroundingSeam() : groundingSeam(grounded, answer),
    ...(opts.commandEventId
      ? { recheckCommandEventId: opts.commandEventId, recheckDeliveryId: opts.deliveryId }
      : {}),
  });
}

/** The REAL job-handler path — what a pg-boss delivery of a verify intent runs,
 * including the stale-authority re-drive inside the handler. */
async function handlerDeliver(
  qid: string,
  opts: {
    grounded?: boolean;
    answer?: string;
    jobId?: string;
    placementAuthorities?: PlacementVerificationAuthority[];
  } = {},
) {
  const grounded = opts.grounded ?? true;
  const answer = opts.answer ?? '代词';
  const handler = buildSourceVerifyHandler(db, {
    runTaskFn: makeRunTask({ grounded, answer }),
    imageFetchFn: fakeImageFetch,
    sourceGroundingFn: groundingSeam(grounded, answer),
    sourceGroundingPreflightFn: (i) => assertSourceGroundingLaneConfigured(i),
  });
  const job = {
    id: opts.jobId ?? `arc-job-${TAG}-${qid.slice(-6)}`,
    data: {
      question_ids: [qid],
      ...(opts.placementAuthorities?.length
        ? { placement_authorities: opts.placementAuthorities }
        : {}),
    },
  };
  await handler([job as never]);
}

async function dumpState(qid: string) {
  const [row] = await db.select().from(question).where(eq(question.id, qid));
  const [lc] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, qid));
  const verifyEvents = await db
    .select({
      id: event.id,
      outcome: event.outcome,
      payload: event.payload,
      created: event.created_at,
    })
    .from(event)
    .where(and(eq(event.action, 'experimental:source_verify'), eq(event.subject_id, qid)))
    .orderBy(desc(event.created_at));
  const terminal = verifyEvents.filter((e) => e.outcome !== 'error');
  const paid = await db.execute(
    sql`select state, delivery_id, result_json, application_json from paid_effect
        where family = 'source_verify' and entity_id = ${qid} order by updated_at`,
  );
  const verifications = await db.execute(
    sql`select policy_id, outcome, evidence from question_admission_verification
        where revision_id in (select revision_id from question_revision where group_id = ${qid})`,
  );
  return {
    draft_status: row?.draft_status,
    lifecycle: lc
      ? {
          suspended: lc.suspended,
          suspension_reason: lc.suspension_reason,
          admission: lc.scoring_admission_state,
          withheld_reason: lc.scoring_admission_withheld_reason,
          revision: lc.current_revision_id,
          generation: lc.scoring_admission_generation,
        }
      : null,
    verify_events: verifyEvents.map((e) => ({
      id: e.id,
      outcome: e.outcome,
      config_error: (e.payload as Record<string, unknown> | null)?.config_error,
      created: e.created,
    })),
    terminal_events: terminal.length,
    verifications: verifications as unknown[],
    paid_effect: paid as unknown[],
  };
}

async function sweep() {
  const enqueued: Array<{
    verifier: string;
    questionIds: string[];
    authorities?: PlacementVerificationAuthority[];
  }> = [];
  const result = await recoverOrphanVerifyDispatches(db, {
    enqueue: async (verifier, questionIds, _options, placementAuthorities) => {
      enqueued.push({ verifier, questionIds, authorities: placementAuthorities });
    },
    sourceVerifyRecoveryPreflight: () =>
      assertSourceGroundingLaneConfigured({ db, subjectProfile: profile }),
  });
  const intents = await db.execute(
    sql`select subject_id, payload->>'recovery_epoch' as epoch, payload->'placement_authority' as authority,
               created_at from event
        where action = 'experimental:verify_dispatch_intent' order by created_at`,
  );
  const completions = await db.execute(
    sql`select subject_id, payload->>'recovery_epoch' as epoch, payload->>'disposition' as disposition,
               payload->>'recovery' as recovery from event
        where action = 'experimental:verify_dispatch' order by created_at`,
  );
  return { result, enqueued, intents, completions };
}

async function webSupplySegment(qid: string, c: SeedContent) {
  const [lc] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, qid));
  const demandId = `arc-demand-${TAG}-${qid.slice(-6)}`;
  const claimId = `arc-claim-${TAG}-${qid.slice(-6)}`;
  const attemptId = `arc-attempt-${TAG}-${qid.slice(-6)}`;
  const fencingToken = randomUUID();
  // A real claim+attempt lets the SAME demand resume inside the real placement
  // delivery path (runWebSupply -> resumeWebSupply), so the acquisition seam is
  // exercised exactly like production: a config-error hold must never reach a
  // second paid fetch.
  await db.insert(placement_starter_claim).values({
    id: claimId,
    fingerprint: `arc-claim-fp-${TAG}-${qid.slice(-6)}`,
    goal_id: `arc-goal-${TAG}-ws-${qid.slice(-6)}`,
    semantic_goal_revision_id: `arc-sgr-${TAG}-${qid.slice(-6)}`,
    subject_id: profile.id,
    knowledge_id: KID,
    demand_id: demandId,
    target_id: `arc-target-${TAG}`,
    status: 'verifying',
    supply_route: 'sourcing_web',
    budget_limit_micro_usd: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  await db.insert(placement_starter_attempt).values({
    id: attemptId,
    claim_id: claimId,
    pg_boss_job_id: `arc-job-${TAG}-${qid.slice(-6)}`,
    delivery_no: 1,
    fencing_token: fencingToken,
    status: 'verifying',
    lease_expires_at: new Date(Date.now() + 3600_000),
    started_at: new Date(Date.now() - 2 * 3600_000),
    created_at: new Date(),
    updated_at: new Date(),
  });
  const q = {
    kind: 'choice',
    prompt_md: `${c.prompt_md} arc marker ${TAG} alpha bravo charlie delta echo foxtrot`,
    reference_md: c.reference_md,
    choices_md: c.choices,
    difficulty: 2,
    knowledge_ids: [KID],
    source_url: `https://example.edu/wenyan/${qid}`,
    source_title: '论语 注疏',
    extract: `${c.extract} arc marker ${TAG} alpha bravo charlie delta echo foxtrot`,
  };
  const hash = `sha256:${'a'.repeat(64)}`;
  const submission = {
    candidate: {
      candidateId: `cand-${qid}`,
      question: q,
      extractionHash: hash,
      sourceId: null,
      knowledgeHints: [],
      stagedAssetIds: [],
    },
    requestId: `req-${qid}`,
    request: {
      request_id: `req-${qid}`,
      source_route: 'sourcing_web',
      candidate: {
        candidate_id: `cand-${qid}`,
        question: q,
        extraction_hash: hash,
        knowledge_hints: [],
        source_id: null,
      },
      knowledge_ids: [KID],
    },
    candidateDigest: 'arc-candidate-digest',
    extractDigest: 'arc-extract-digest',
    receipt: { status: 'pending', question_id: qid },
    binding: {
      questionId: qid,
      revisionId: lc?.current_revision_id ?? 'arc-rev',
      digest: 'arc-digest',
      generation: lc?.scoring_admission_generation ?? 0,
      publicationEventId: 'arc-pub',
    },
  };
  const revRows = await db.execute(
    sql`select revision_id, integrity_digest from question_revision where revision_id = ${lc?.current_revision_id ?? ''}`,
  );
  const rev = (revRows as unknown as Array<{ revision_id: string; integrity_digest: string }>)[0];
  if (rev) submission.binding.digest = rev.integrity_digest;
  const item = {
    demandId,
    knowledgeId: KID,
    kind: 'any' as const,
    difficultyBand: null,
    count: 1,
    routePreference: ['sourcing_web' as const],
    placementClaimId: claimId,
  };
  // The resume path refuses a demand whose persisted fingerprint does not match
  // the recomputed intent, so seed the real one.
  const fingerprint = canonicalHash({
    item: { ...item, routePreference: undefined },
    trace: undefined,
    subjectId: profile.id,
  });
  await db.insert(event).values({
    id: `arc-ws-${qid}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'supply_executor',
    action: 'experimental:web_supply',
    subject_kind: 'query',
    subject_id: demandId,
    outcome: 'partial',
    payload: {
      version: 1,
      sequence: 0,
      demandId,
      fingerprint,
      item,
      subjectId: profile.id,
      causeId: null,
      producerTaskRunId: `arc-run-${TAG}`,
      phase: 'verifying',
      reason: 'awaiting_verification_and_admission',
      activeRequestId: null,
      submissions: [submission],
      blockedSources: [],
      queryPlan: [],
      fetchedAt: ts(),
      costUsd: 0,
      serving: [],
      observations: [],
    } as never,
    caused_by_event_id: null,
    created_at: new Date(),
    ingest_at: new Date(),
  });
  // Acquisition seam: the only paid fetch entry point. The seeded demand already
  // spent its one acquisition; a correct observe must never reach fetch again.
  let fetchCalls = 0;
  const fetch = async () => {
    fetchCalls += 1;
    throw new Error('arc: acquisition fetch invoked on a held demand');
  };
  const controller = new AbortController();
  const resumed = await runWebSupply({
    db,
    item,
    trace: undefined,
    causeId: null,
    fetch,
    subjectProfile: profile as never,
    placement: {
      attempt: {
        claimId,
        attemptId,
        pgBossJobId: `arc-job-${TAG}-${qid.slice(-6)}`,
        deliveryNo: 1,
        fencingToken,
        leaseExpiresAt: new Date(Date.now() + 3600_000),
        // Past the decision deadline: if the candidate progress ever reads
        // 'pending', the poll returns on the first deadline check.
        startedOn: new Date(Date.now() - 2 * 3600_000),
      },
      heartbeat: {
        done: new Promise<void>(() => {}),
        assertHealthy: async () => {},
        stop: async () => {},
      },
      signal: controller.signal,
    },
  });
  const observed = await observeWebSuppliesForQuestion(db, qid);
  const after = await db.execute(
    sql`select payload->>'phase' as phase, payload->>'reason' as reason,
               payload->'observations' as observations, payload->>'nextRoute' as next_route,
               payload->>'fallbackJobId' as fallback_job_id from event
        where action='experimental:web_supply' and subject_id=${demandId}
        order by (payload->>'sequence')::int desc limit 1`,
  );
  return {
    demandId,
    fetchCalls,
    resumed: { phase: resumed.phase, reason: resumed.reason, observations: resumed.observations },
    observed,
    after: (after as unknown as unknown[])[0],
  };
}

/** 401/403 park seam: a FRESH placement demand whose acquisition throws a
 * provider-auth rejection must park as config_error (paid effect provably 0),
 * and a later delivery after the lane is fixed must re-drive a refill round —
 * acquisition called again at the same seam. */
async function webSupplyAuthParkSegment() {
  const demandId = `arc-authdemand-${TAG}`;
  const claimId = `arc-authclaim-${TAG}`;
  const attemptId = `arc-authattempt-${TAG}`;
  const fencingToken = randomUUID();
  await db.insert(placement_starter_claim).values({
    id: claimId,
    fingerprint: `arc-authclaim-fp-${TAG}`,
    goal_id: `arc-goal-${TAG}-auth`,
    semantic_goal_revision_id: `arc-authsgr-${TAG}`,
    subject_id: profile.id,
    knowledge_id: KID,
    demand_id: demandId,
    target_id: `arc-authtarget-${TAG}`,
    status: 'verifying',
    supply_route: 'sourcing_web',
    budget_limit_micro_usd: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  await db.insert(placement_starter_attempt).values({
    id: attemptId,
    claim_id: claimId,
    pg_boss_job_id: `arc-authjob-${TAG}`,
    delivery_no: 1,
    fencing_token: fencingToken,
    status: 'verifying',
    lease_expires_at: new Date(Date.now() + 3600_000),
    started_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  });
  const item = {
    demandId,
    knowledgeId: KID,
    kind: 'any' as const,
    difficultyBand: null,
    count: 1,
    routePreference: ['sourcing_web' as const],
    placementClaimId: claimId,
  };
  const placement = {
    attempt: {
      claimId,
      attemptId,
      pgBossJobId: `arc-authjob-${TAG}`,
      deliveryNo: 1,
      fencingToken,
      leaseExpiresAt: new Date(Date.now() + 3600_000),
      startedOn: new Date(),
    },
    heartbeat: {
      done: new Promise<void>(() => {}),
      assertHealthy: async () => {},
      stop: async () => {},
    },
    signal: new AbortController().signal,
  };
  let fetchCalls = 0;
  const fetch401 = async () => {
    fetchCalls += 1;
    throw new AgentRunError({
      kind: 'SourcingTask',
      taskRunId: `arc-auth-${TAG}-t${fetchCalls}`,
      subtype: 'api_error_result',
      apiErrorStatus: 401,
      errors: ['arc: unauthorized'],
    });
  };
  const fetchOk = async (): Promise<RunWebFetchCandidatesResult> => {
    fetchCalls += 1;
    return {
      status: 'ok' as const,
      candidates: [],
      imageCandidates: [],
      queryPlan: [],
      fetchedAt: ts(),
      taskRunId: `arc-auth-${TAG}-t${fetchCalls}`,
      costUsd: 0,
    };
  };
  const supplyParams = {
    db,
    item,
    trace: undefined,
    causeId: null,
    subjectProfile: profile as never,
    placement,
  };
  const first = await runWebSupply({ ...supplyParams, fetch: fetch401 });
  const outcome1 = await placementWebDemandOutcome(db, demandId);
  // Same delivery resumed while the lane is still broken: the prior config_error
  // round redrives into a refill identity, fetch parks it again.
  const second = await runWebSupply({ ...supplyParams, fetch: fetch401 });
  const outcome2 = await placementWebDemandOutcome(db, demandId);
  // Lane repaired (a different key would answer): the next delivery opens the
  // last refill round and reaches the paid acquisition seam.
  const third = await runWebSupply({ ...supplyParams, fetch: fetchOk });
  const outcome3 = await placementWebDemandOutcome(db, demandId);
  const rounds = await db.execute(
    sql`select subject_id, payload->>'phase' as phase, payload->>'reason' as reason from event
        where action='experimental:web_supply' and subject_id like ${`${demandId}%`}
        order by created_at`,
  );
  return {
    demandId,
    fetchCalls,
    first: { phase: first.phase, reason: first.reason, costUsd: first.costUsd },
    outcome1,
    second: { phase: second.phase, reason: second.reason },
    outcome2,
    third: { phase: third.phase, reason: third.reason },
    outcome3,
    rounds,
  };
}

async function main() {
  note('arc:start', {
    tag: TAG,
    db: 'loom_dev_t3_5ba50596_acba784d',
    credentialEnv: 'OPENCODE_API_KEY=arc-dummy-a (never sent)',
  });
  await seedKnowledge();

  const Q1 = `q1zhi-${TAG}`;
  await seedQuestion(Q1, CONTENT.zhi);
  await primeDispatch(Q1);
  // --- Phase A: broken lane -------------------------------------------------
  await lane('stale');
  const E1 = `cmd-${TAG}-e1`;
  const r1 = await deliver(Q1, {
    commandEventId: E1,
    deliveryId: `d1-${TAG}`,
    answer: CONTENT.zhi.answer,
  });
  note('A1:broken-delivery', { qid: Q1, status: r1.status });
  const s1 = await dumpState(Q1);
  note('A1:state', s1 as Record<string, unknown>);
  if (r1.status !== 'skipped:config_error')
    throw new Error(`expected skipped:config_error, got ${r1.status}`);
  if (s1.terminal_events !== 0) throw new Error('terminal event written for config_error');

  const r2 = await deliver(Q1, {
    commandEventId: E1,
    deliveryId: `d2-${TAG}`,
    answer: CONTENT.zhi.answer,
  });
  const s2 = await dumpState(Q1);
  note('A2:second-broken-delivery', { status: r2.status, paid_effect: s2.paid_effect });
  if (r2.status !== 'skipped:config_error')
    throw new Error(`A2 expected skipped:config_error, got ${r2.status}`);

  // The sweep while the lane is still broken: the zero-send preflight fails, so
  // no recovery intent is written and the hold is left exactly where it is.
  const sweepBroken = await sweep();
  note('A3:sweep-while-broken', sweepBroken as Record<string, unknown>);
  if (sweepBroken.enqueued.some((entry) => entry.questionIds.includes(Q1)))
    throw new Error('broken-lane sweep still dispatched Q1');

  // --- Phase B: lane repair → recovery sweep → real grounding ---------------
  await lane('fixed');
  const sweep1 = await sweep();
  note('B1:sweep-after-repair', sweep1 as Record<string, unknown>);
  if (!sweep1.enqueued.some((entry) => entry.questionIds.includes(Q1)))
    throw new Error('repaired-lane sweep did not re-drive Q1');
  const countsBefore = { ...counts };
  const r3 = await deliver(Q1, { answer: CONTENT.zhi.answer });
  const s3 = await dumpState(Q1);
  note('B2:post-repair-delivery', {
    status: r3.status,
    groundingCalls: counts.grounding - countsBefore.grounding,
    solveCalls: counts.solve - countsBefore.solve,
    draft_status: s3.draft_status,
    lifecycle: s3.lifecycle,
    verify_events: s3.verify_events,
  });
  if (counts.grounding - countsBefore.grounding !== 1)
    throw new Error('grounding seam not called exactly once');
  if (s3.terminal_events < 1) throw new Error('no terminal verify event after repair');

  // --- Phase C: not_grounded variant fails on merit; merit hold releases ----
  const Q2 = `q2hu-${TAG}`;
  await seedQuestion(Q2, CONTENT.hu);
  await primeDispatch(Q2);
  const gBefore = counts.grounding;
  const r4 = await deliver(Q2, { grounded: false, answer: CONTENT.hu.answer });
  const s4 = await dumpState(Q2);
  note('C1:not-grounded', {
    status: r4.status,
    groundingCalls: counts.grounding - gBefore,
    draft_status: s4.draft_status,
    lifecycle: s4.lifecycle,
    verify_events: s4.verify_events,
  });
  // A merit-based failed hold still has a verdict to override: release stays
  // accepted. (Contrast with the suspended-hold rejection in Phase F.)
  const rel2 = await runServingAction(db, {
    questionId: Q2,
    command: 'release_verify_hold',
    idempotencyKey: `arc-rel2-${TAG}`,
  });
  note('C2:release-merit-hold', { accepted: rel2.accepted });
  if (rel2.accepted !== true) throw new Error('merit-failed hold release was not accepted');

  // --- Phase D: transient 429 hold → sweep re-drives the error epoch --------
  const Q5 = `q5wei-${TAG}`;
  await seedQuestion(Q5, {
    prompt_md: '「为」在「可以为师矣」中作？',
    reference_md: '动词',
    choices: ['动词', '介词', '连词'],
    extract: '「为」在「可以为师矣」中作动词，意为「成为、当作」。',
    answer: '动词',
  });
  await primeDispatch(Q5);
  try {
    await deliver(Q5, { transient: true, answer: '动词' });
    throw new Error('transient grounding did not throw');
  } catch (err) {
    note('D1:transient-delivery-threw', {
      qid: Q5,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const s5 = await dumpState(Q5);
  note('D1:transient-state', s5 as Record<string, unknown>);
  if (s5.terminal_events !== 0) throw new Error('terminal event written for transient');
  if (s5.verify_events.filter((e) => e.outcome === 'error').length === 0)
    throw new Error('no non-terminal error event for transient hold');
  if (s5.verify_events.some((e) => e.config_error === true))
    throw new Error('transient hold mislabelled config_error');
  const sweepT = await sweep();
  note('D2:sweep-after-transient', sweepT as Record<string, unknown>);
  if (!sweepT.enqueued.some((entry) => entry.questionIds.includes(Q5)))
    throw new Error('sweep did not re-drive the transient hold');
  const g3 = counts.grounding;
  await handlerDeliver(Q5, { answer: '动词' });
  const s5b = await dumpState(Q5);
  note('D3:transient-recovered', {
    groundingCalls: counts.grounding - g3,
    draft_status: s5b.draft_status,
    verify_events: s5b.verify_events,
  });
  if (counts.grounding - g3 !== 1) throw new Error('transient re-drive skipped grounding');
  if (s5b.terminal_events < 1) throw new Error('transient re-drive wrote no terminal event');

  // --- Phase E: recovery intent with stale placement authority --------------
  // The original intent carries an authority the claim has since moved past:
  // the handler must re-run provenance-safe without it — never "done with
  // nothing written".
  const Q6 = `q6gu-${TAG}`;
  await seedQuestion(Q6, {
    prompt_md: '「故」在「温故而知新」中作？',
    reference_md: '名词',
    choices: ['名词', '连词', '副词'],
    extract: '「故」在「温故而知新」中作名词，指旧的知识。',
    answer: '名词',
  });
  const staleClaimId = `arc-staleclaim-${TAG}`;
  const staleAttemptId = `arc-staleattempt-${TAG}`;
  const staleFence = randomUUID();
  await db.insert(placement_starter_claim).values({
    id: staleClaimId,
    fingerprint: `arc-staleclaim-fp-${TAG}`,
    goal_id: `arc-goal-${TAG}-stale`,
    semantic_goal_revision_id: `arc-stalesgr-${TAG}`,
    subject_id: profile.id,
    knowledge_id: KID,
    demand_id: `arc-staledemand-${TAG}`,
    target_id: `arc-staletarget-${TAG}`,
    status: 'verifying',
    supply_route: 'sourcing_web',
    budget_limit_micro_usd: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  await db.insert(placement_starter_attempt).values({
    id: staleAttemptId,
    claim_id: staleClaimId,
    pg_boss_job_id: `arc-stalejob-${TAG}`,
    delivery_no: 1,
    fencing_token: staleFence,
    status: 'verifying',
    lease_expires_at: new Date(Date.now() + 3600_000),
    started_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  });
  const staleAuthority: PlacementVerificationAuthority = {
    claim_id: staleClaimId,
    attempt_id: staleAttemptId,
    question_id: Q6,
    verification_authority_epoch: randomUUID(),
    fencing_token: staleFence,
  };
  // The real authority binding `authorizePlacementQuestion` would have written:
  // the recovery intent must carry authority over a row that actually existed.
  await db.insert(placement_starter_attempt_question).values({
    attempt_id: staleAttemptId,
    claim_id: staleClaimId,
    question_id: Q6,
    canonical_hash: `arc-ch-${TAG}`,
    verification_authority_epoch: staleAuthority.verification_authority_epoch,
    verification_status: 'authorized',
    created_at: new Date(),
  });
  await primeDispatch(Q6, staleAuthority);
  await lane('stale');
  const r10 = await deliver(Q6, { answer: '名词' });
  if (r10.status !== 'skipped:config_error')
    throw new Error(`Q6 expected config_error, got ${r10.status}`);
  // The claim moves past the authority while the hold sits: the recovery intent
  // synthesized below inherits the NOW-dead attempt reference.
  await db.execute(
    sql`update placement_starter_attempt set status = 'interrupted', updated_at = now() where id = ${staleAttemptId}`,
  );
  await lane('fixed');
  const sweepS = await sweep();
  note('E1:sweep-stale-authority', sweepS as Record<string, unknown>);
  const q6Enq = sweepS.enqueued.find((entry) => entry.questionIds.includes(Q6));
  if (!q6Enq) throw new Error('sweep did not re-drive Q6');
  const g4 = counts.grounding;
  await handlerDeliver(Q6, {
    answer: '名词',
    placementAuthorities: q6Enq.authorities ?? [staleAuthority],
  });
  const s6 = await dumpState(Q6);
  note('E2:stale-authority-recovery', {
    carriedAuthority: q6Enq.authorities ?? null,
    groundingCalls: counts.grounding - g4,
    draft_status: s6.draft_status,
    verify_events: s6.verify_events,
  });
  if (s6.terminal_events < 1)
    throw new Error('stale-authority recovery intent died with nothing written');

  // --- Phase F: unknown claim holds the same command -------------------------
  // The held path is only reachable for a NOT-yet-verified question: a verified
  // one short-circuits at 'skipped:already_verified' before the claim check, so
  // this runs on Q4 while it is still inside its config_error hold.
  const Q4 = `q4ye-${TAG}`;
  await seedQuestion(Q4, CONTENT.ye);
  await primeDispatch(Q4);
  await lane('stale');
  const r9 = await deliver(Q4, { answer: CONTENT.ye.answer });
  if (r9.status !== 'skipped:config_error')
    throw new Error(`Q4 expected config_error, got ${r9.status}`);
  const E2 = `cmd-${TAG}-e2`;
  const r7 = await deliver(Q4, {
    commandEventId: E2,
    deliveryId: `d7-${TAG}`,
    answer: CONTENT.ye.answer,
  });
  note('F1:recheck-while-broken', { status: r7.status });
  // Fabricate a crashed paid call: 'unknown' requires the state-shape columns to
  // match (result/application cleared, lease cleared, unresolved_reason set).
  await db.execute(sql`
    update paid_effect set state = 'unknown', unresolved_reason = 'arc:simulated-crash-after-send',
      result_json = null, application_json = null, applied_at = null, result_recorded_at = null,
      send_lease_expires_at = null, application_attempts = 0, last_application_error = null,
      updated_at = now()
    where family='source_verify' and entity_id=${Q4} and entity_revision=${E2} and unit='source_verify@1'
  `);
  const r8 = await deliver(Q4, {
    commandEventId: E2,
    deliveryId: `d8-${TAG}`,
    answer: CONTENT.ye.answer,
  });
  note('F2:recheck-with-unknown-claim', { status: r8.status });

  // --- Phase G: supply observe on a still-held question ---------------------
  const ws = await webSupplySegment(Q4, CONTENT.ye);
  note('G1:supply-observe-on-config-error-hold', ws as Record<string, unknown>);
  if (ws.fetchCalls !== 0) throw new Error('config-error hold authorized a paid refill');

  // The release button on a suspended (no-verdict) hold must NOT clear it: the
  // question stays draft+withheld and can never reach admission without a real
  // source_verify verdict.
  const rel4 = await runServingAction(db, {
    questionId: Q4,
    command: 'release_verify_hold',
    idempotencyKey: `arc-rel4-${TAG}`,
  });
  const s4b = await dumpState(Q4);
  note('G2:release-suspended-hold', {
    accepted: rel4.accepted,
    draft_status: s4b.draft_status,
    lifecycle: s4b.lifecycle,
  });
  if (rel4.accepted !== false)
    throw new Error('release_verify_hold accepted on an unverified suspended hold');
  if (s4b.lifecycle?.suspended !== true)
    throw new Error('suspended hold was cleared by the rejected release');

  // --- Phase H: placement 401 park → re-drive → acquisition seam ------------
  const ap = await webSupplyAuthParkSegment();
  note('H1:placement-401-park-lifecycle', ap as Record<string, unknown>);
  if (ap.outcome1 !== 'config_error') throw new Error('401 did not park as config_error');
  if (ap.outcome2 !== 'config_error') throw new Error('still-broken delivery did not re-park');
  if (ap.fetchCalls !== 3)
    throw new Error(`acquisition seam expected 3 calls, got ${ap.fetchCalls}`);

  await lane('fixed');
  note('arc:done', { counts });
  console.log('\n=== EVIDENCE JSON ===');
  console.log(JSON.stringify({ tag: TAG, evidence }, null, 2));
}

main()
  .catch((err) => {
    console.error('ARC FAILED', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      // system_config MUST be restored: a lingering stale task override would keep
      // the dev grounding lane broken. event / question_admission_verification /
      // question_revision are append-only (assessment_immutable_guard); seeded rows,
      // lifecycle rows and paid_effect claims are left in place — they are the
      // arc's audit trail, tagged by this run's TAG.
      await db.execute(sql`delete from system_config where updated_by = 'yuk1849-arc'`);
      await db.execute(
        sql`delete from placement_starter_attempt_question where claim_id like 'arc-%claim-arc%'`,
      );
      await db.execute(
        sql`delete from placement_starter_cost_component where claim_id like 'arc-%claim-arc%'`,
      );
      await db.execute(
        sql`delete from placement_starter_attempt where claim_id like 'arc-%claim-arc%'`,
      );
      await db.execute(sql`delete from placement_starter_claim where id like 'arc-%claim-arc%'`);
    } catch (e) {
      console.error('cleanup failed', e);
    }
    process.exit(process.exitCode ?? 0);
  });
