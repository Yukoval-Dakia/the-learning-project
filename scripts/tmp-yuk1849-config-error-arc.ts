// YUK-1849 — dev-DB acceptance arc for the CURRENT config_error hold + automatic
// outbox recovery design (f627180ca / 64bec57b3 semantics — NOT the superseded
// operator-recheck design). Real dev Postgres rows and real lane machinery; the
// only fakes sit at the external boundary (provider call + image bytes), and the
// grounding call is counted at that seam. No pg-boss send, no paid call.
//
// Each question is primed with the submission-time verify intent + completion so
// the sweep must take the recovery_epoch path (a completed original intent cannot
// re-dispatch; only a changed lane fingerprint re-arms the config-error epoch).
//
// Run:
//   DATABASE_URL=postgres://loom_dev:loom_dev@127.0.0.1:5434/loom_dev_t3_5ba50596_acba784d \
//   OPENCODE_API_KEY=arc-dummy-a pnpm exec tsx scripts/tmp-yuk1849-config-error-arc.ts

import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  assertSourceGroundingLaneConfigured,
  runSourceGroundingVerify,
  sourceGroundingLaneFingerprint,
} from '@/capabilities/practice/grading/server/judge/source-grounding-verify';
import type {
  RunTaskFn,
  SourceGroundingFn,
} from '@/capabilities/practice/question-bank/jobs/source_verify';
import { runSourceVerify } from '@/capabilities/practice/question-bank/jobs/source_verify';
import {
  recoverOrphanVerifyDispatches,
  writeVerifyDispatchIntent,
} from '@/capabilities/practice/question-bank/server/verify-dispatch-outbox';
import {
  observeWebSuppliesForQuestion,
  runWebSupply,
} from '@/capabilities/practice/supply/server/web-supply';
import { canonicalHash } from '@/core/migration/canonical';
import { db } from '@/db/client';
import {
  event,
  knowledge,
  placement_starter_attempt,
  placement_starter_claim,
  question,
  question_group_lifecycle,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events/index';
import { hydrateConfigFromDb } from '@/server/config/hydrate';
import { resolveSubjectProfile } from '@/subjects/profile';

const profile = resolveSubjectProfile(null);
const TAG = `arc${Date.now()}`;
const KID = `k-${TAG}`;
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

async function seedKnowledge() {
  const now = new Date();
  await db.insert(knowledge).values({
    id: KID,
    name: '之',
    domain: 'yuwen',
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedQuestion(id: string, c: SeedContent) {
  const now = new Date();
  const url = `https://example.edu/wenyan/${id}`;
  await db.insert(question).values({
    id,
    kind: 'choice',
    prompt_md: c.prompt_md,
    reference_md: c.reference_md,
    rubric_json: null,
    choices_md: c.choices,
    judge_kind_override: 'exact',
    knowledge_ids: [KID],
    difficulty: 2,
    source: 'web_sourced',
    source_ref: url,
    draft_status: 'draft',
    created_by: { by: 'ai', task_kind: 'SourcingTask' },
    metadata: {
      web_sourced: {
        url,
        title: '论语 注疏',
        fetched_at: '2026-06-06T00:00:00.000Z',
        whitelist_match: false,
        extract: c.extract,
      },
      source_ref_kind: 'url',
      single_source_grounding: true,
      image_candidate_source_asset_id: `asset-${id}`,
    } as never,
    image_refs: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

/** The submission-time verify dispatch the pipeline already committed for this row. */
async function primeDispatch(qid: string) {
  const intentId = await writeVerifyDispatchIntent(db, {
    questionId: qid,
    verifier: 'source_verify',
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
        ('task.SourceGroundingVerifyTask.model', '"mimo-v2.5"'::jsonb, 1, 'yuk1849-arc', now(), now())
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
  const fp = sourceGroundingLaneFingerprint();
  note(`lane:${mode}`, { hydrate: report, fingerprint: fp });
  return fp;
}

const groundingSeam = (grounded: boolean, answer: string): SourceGroundingFn => {
  const runTask = makeRunTask({ grounded, answer });
  return (p) =>
    runSourceGroundingVerify({ ...p, runTaskFn: runTask, imageFetchFn: fakeImageFetch });
};

async function deliver(
  qid: string,
  opts: {
    grounded?: boolean;
    answer?: string;
    commandEventId?: string;
    deliveryId?: string;
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
    sourceGroundingFn: groundingSeam(grounded, answer),
    ...(opts.commandEventId
      ? { recheckCommandEventId: opts.commandEventId, recheckDeliveryId: opts.deliveryId }
      : {}),
  });
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
      lane_fingerprint: (e.payload as Record<string, unknown> | null)?.lane_fingerprint,
      created: e.created,
    })),
    terminal_events: terminal.length,
    verifications: verifications as unknown[],
    paid_effect: paid as unknown[],
  };
}

async function sweep() {
  const enqueued: Array<{ verifier: string; questionIds: string[] }> = [];
  const result = await recoverOrphanVerifyDispatches(db, {
    enqueue: async (verifier, questionIds) => {
      enqueued.push({ verifier, questionIds });
    },
    sourceVerifyLaneFingerprint: () => sourceGroundingLaneFingerprint(),
    sourceVerifyRecoveryPreflight: () =>
      assertSourceGroundingLaneConfigured({ db, subjectProfile: profile }),
  });
  const intents = await db.execute(
    sql`select subject_id, payload->>'recovery_epoch' as epoch, payload->>'lane_fingerprint' as fp,
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
    goal_id: `arc-goal-${TAG}`,
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
    prompt_md: c.prompt_md,
    reference_md: c.reference_md,
    choices_md: c.choices,
    difficulty: 2,
    knowledge_ids: [KID],
    source_url: `https://example.edu/wenyan/${qid}`,
    source_title: '论语 注疏',
    extract: c.extract,
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
  const fpStale = await lane('stale');
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

  // --- Phase B: lane repair → recovery sweep → real grounding ---------------
  const fpFixed = await lane('fixed');
  if (fpFixed === fpStale) throw new Error('fingerprint did not change after lane repair');
  const sweep1 = await sweep();
  note('B1:sweep-after-repair', sweep1 as Record<string, unknown>);
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

  // --- Phase C: not_grounded variant fails on merit -------------------------
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

  // --- Phase D: credential-only change re-arms ------------------------------
  const Q3 = `q3yi-${TAG}`;
  await seedQuestion(Q3, CONTENT.yi);
  await primeDispatch(Q3);
  await lane('stale');
  const r5 = await deliver(Q3, { answer: CONTENT.yi.answer });
  if (r5.status !== 'skipped:config_error')
    throw new Error(`Q3 expected config_error, got ${r5.status}`);
  const fpBeforeCred = sourceGroundingLaneFingerprint();
  process.env.OPENCODE_API_KEY = 'arc-dummy-b';
  const fpAfterCred = sourceGroundingLaneFingerprint();
  const credChanged = fpAfterCred !== fpBeforeCred;
  const sweepCred = await sweep();
  note('D1:credential-only-change', {
    fpBeforeCred,
    fpAfterCred,
    credentialChangeAltersFingerprint: credChanged,
    sweep: sweepCred.result,
    intents: sweepCred.intents,
  });
  if (!credChanged) throw new Error('credential change did not alter lane fingerprint');
  await lane('fixed');
  process.env.OPENCODE_API_KEY = 'arc-dummy-a';
  const sweep2 = await sweep();
  note('D2:sweep-after-real-repair', sweep2 as Record<string, unknown>);
  const g2 = counts.grounding;
  const r6 = await deliver(Q3, { answer: CONTENT.yi.answer });
  note('D3:q3-recovered', { status: r6.status, groundingCalls: counts.grounding - g2 });

  // --- Phase E: unknown claim holds the same command -------------------------
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
  note('E1:recheck-while-broken', { status: r7.status });
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
  note('E2:recheck-with-unknown-claim', { status: r8.status });

  // --- Phase F: supply observe on a still-held question ---------------------
  const ws = await webSupplySegment(Q4, CONTENT.ye);
  note('F1:supply-observe-on-config-error-hold', ws as Record<string, unknown>);
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
        sql`delete from placement_starter_attempt_question where claim_id like 'arc-claim-arc%'`,
      );
      await db.execute(
        sql`delete from placement_starter_attempt where claim_id like 'arc-claim-arc%'`,
      );
      await db.execute(sql`delete from placement_starter_claim where id like 'arc-claim-arc%'`);
    } catch (e) {
      console.error('cleanup failed', e);
    }
    process.exit(process.exitCode ?? 0);
  });
