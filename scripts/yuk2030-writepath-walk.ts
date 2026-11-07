// YUK-2030 attempt_3 — real-PG write/enqueue-path walk for the coordination rule.
// Each leg exercises a changed write/enqueue path on the real dev PG with real
// bound params; model-task legs use the real runner binding with only the
// provider substituted (real OpenDesign route, currently 500ing).
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { AgentRunError } from '@/ai/agent-run-error';
import { PREPARE_INTERVENTION_JOB } from '@/capabilities/agency/server/intervention/probe-result-subscription';
import { rearmInterventionPreparationWait } from '@/capabilities/agency/server/intervention/reconcile';
import { runNoteGenerate } from '@/capabilities/notes/jobs/note_generate';
import {
  attrsWithGenerationWait,
  readNoteGenerationWait,
} from '@/capabilities/notes/server/note-generation-failure';
import { recoverNoteHandoffsAndClaims } from '@/capabilities/notes/server/note-handoff';
import { ADMISSION_FAMILY } from '@/capabilities/practice/question-bank/server/admission/enqueue';
import { ADMISSION_STAGE_FAMILY } from '@/capabilities/practice/question-bank/server/admission/stages';
import { recoverExpiredAdmissionWaits } from '@/capabilities/practice/question-bank/server/admission/waiting-recovery';
import { runItemPriorBackfillOperation } from '@/capabilities/practice/question-bank/server/item-prior-durable-operation';
import { QUESTION_ADMISSION_PAID_UNIT } from '@/core/question-admission-policy';
import { db } from '@/db/client';
import { artifact } from '@/db/schema/artifacts';
import { intervention } from '@/db/schema/learner-state';
import { paid_effect, paid_effect_control } from '@/db/schema/paid-effects';
import { createRunLifecycle } from '@/server/ai/run-lifecycle';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { getStartedBoss } from '@/server/boss/client';

const log = (ev: string, data: Record<string, unknown>) =>
  console.log(JSON.stringify({ ev, ...data }));

async function settleUnbilledRun(): Promise<{ taskRunId: string; err: AgentRunError }> {
  process.env.OPENCODE_API_KEY ??= 'walk-key';
  const lifecycle = createRunLifecycle({
    db,
    kind: 'QuestionAdmissionSolveTask',
    timeoutMs: 60_000,
    logScope: 'yuk2030-walk',
  });
  try {
    await lifecycle.start({ question: 'write-side probe' });
    lifecycle.transportEvidence.noteArmed();
    lifecycle.transportEvidence.noteFetchLoop('root');
    const record = lifecycle.transportEvidence.beginFetch();
    lifecycle.transportEvidence.recordFetchSettled(record, 500);
    const err = new AgentRunError({
      kind: 'QuestionAdmissionSolveTask',
      taskRunId: lifecycle.taskRunId,
      subtype: 'api_error_result',
      apiErrorStatus: 500,
      errors: ['[code=internal_error] upstream error'],
      providerFailure: { http_status: 500 },
    });
    await lifecycle.finishFailure(err);
    return { taskRunId: lifecycle.taskRunId, err };
  } finally {
    lifecycle.dispose();
  }
}

async function legNoteWait(): Promise<void> {
  const artifactId = `yuk2030-walk-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  await db.insert(artifact).values({
    id: artifactId,
    type: 'note_atomic',
    title: artifactId,
    parent_artifact_id: null,
    knowledge_ids: [],
    intent_source: 'learning_intent',
    source: 'ai_generated',
    source_ref: null,
    body_blocks: null,
    attrs: {},
    tool_kind: null,
    tool_state: null,
    generation_status: 'pending',
    verification_status: 'not_required',
    generated_by: null,
    history: [],
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const { err } = await settleUnbilledRun();
  const fakeRun = async () => {
    throw err;
  };
  const result = await runNoteGenerate({ db, artifactId, runTaskFn: fakeRun });
  const [row] = await db
    .select({ status: artifact.generation_status, attrs: artifact.attrs })
    .from(artifact)
    .where(eq(artifact.id, artifactId));
  const wait = readNoteGenerationWait(row?.attrs);
  log('note_wait', {
    artifactId,
    result: result.status,
    genStatus: row?.status,
    waits: wait?.waits,
    retryClass: wait?.retry_class,
    retryAt: wait?.retry_at,
    wakeJobId: wait?.wake_job_id,
    evidenceRef: wait?.evidence_ref,
  });

  // Handler-level wake send with real boss (real enqueue, stored wake_job_id).
  const boss = await getStartedBoss();
  await boss.createQueue('note_generate');
  if (wait?.wake_job_id && wait?.retry_at) {
    await boss.send(
      'note_generate',
      { artifact_id: artifactId },
      { id: wait.wake_job_id, startAfter: new Date(wait.retry_at) },
    );
  }
  const [job] = await db.execute<{ id: string; state: string; start_after: string }>(sql`
    select id::text, state, start_after::text from pgboss.job where name = 'note_generate'
    order by created_on desc limit 1`);
  log('note_wake_enqueued', { artifactId, job });

  // Floor walk: age the receipt, kill the wake id, run the real recovery floor.
  const past = new Date(Date.now() - 60_000).toISOString();
  await db
    .update(artifact)
    .set({
      attrs: attrsWithGenerationWait(row?.attrs, {
        ...wait!,
        retry_at: past,
        wake_job_id: randomUUID(), // recorded wake is dead/never landed
      }),
    })
    .where(eq(artifact.id, artifactId));
  const rearmed = await recoverNoteHandoffsAndClaims(db);
  const [row2] = await db
    .select({ attrs: artifact.attrs })
    .from(artifact)
    .where(eq(artifact.id, artifactId));
  const wait2 = readNoteGenerationWait(row2?.attrs);
  const [job2] = await db.execute<{ id: string; state: string }>(sql`
    select id::text, state from pgboss.job where name = 'note_generate'
    order by created_on desc limit 1`);
  log('note_floor_rearm', { artifactId, rearmed, newWakeId: wait2?.wake_job_id, job2 });
}

async function legIntervention(): Promise<void> {
  const interventionId = randomUUID();
  const now = new Date();
  const superseded = randomUUID();
  const srcEventId = randomUUID();
  const conjEventId = randomUUID();
  await db.execute(sql`
    insert into event (id, actor_kind, actor_ref, action, subject_kind, subject_id, payload)
    values
      (${srcEventId}, 'system', 'walk', 'experimental:probe_result', 'learner', 'walk', '{}'::jsonb),
      (${conjEventId}, 'system', 'walk', 'conjecture', 'learner', 'walk', '{}'::jsonb)
  `);
  const { InterventionSnapshot } = await import('@/core/schema/intervention');
  const snapshot = InterventionSnapshot.parse({
    schema_version: 1,
    intervention_id: interventionId,
    intervention_version: 1,
    conjecture: {
      conjecture_id: conjEventId,
      claim_md: 'walk claim md',
      knowledge_id: 'walk-kc',
      knowledge_name: 'walk kc name',
      cause_category: 'concept_misunderstanding',
      target_error_rule_md: 'walk target error rule',
      diagnostic_spec: {
        schema_version: 2,
        target_error_rule_md: 'walk target error rule',
        trigger_conditions_md: 'walk trigger',
        scope_boundary_md: 'walk scope',
        expected_wrong_answer_signature_md: 'walk signature',
        causal_direction_required: false,
      },
      evidence_refs: [{ kind: 'event', id: srcEventId }],
    },
    learner_context: {
      theta_band: 'developing',
      precision_band: 'medium',
      misconception_present: true,
      kc_is_rule_based: false,
    },
    prior_interventions: [],
    disabled_method_ids: [],
    source_probe_result_event_id: srcEventId,
    created_at: now.toISOString(),
  });
  await db.insert(intervention).values({
    id: interventionId,
    version: 1,
    source_probe_result_event_id: srcEventId,
    conjecture_event_id: conjEventId,
    status: 'preparing',
    idempotency_key: `walk-${randomUUID()}`,
    preparation_job_id: superseded,
    snapshot_json: snapshot,
    created_at: now,
    updated_at: now,
  });
  const boss = await getStartedBoss();
  await boss.createQueue(PREPARE_INTERVENTION_JOB);
  const out = await rearmInterventionPreparationWait(db, boss, {
    interventionId,
    version: 1,
    idempotencyKey: `walk-${randomUUID().slice(0, 8)}`,
    supersededJobId: superseded,
    waits: 1,
    delayMs: 300_000,
  });
  const [row] = await db
    .select({ job: intervention.preparation_job_id, status: intervention.status })
    .from(intervention)
    .where(eq(intervention.id, interventionId));
  const [job] = await db.execute<{
    id: string;
    state: string;
    start_after: string;
    data: unknown;
  }>(sql`
    select id::text, state, start_after::text, data from pgboss.job
    where name = ${PREPARE_INTERVENTION_JOB} order by created_on desc limit 1`);
  log('intervention_rearm', {
    interventionId,
    out,
    repointedTo: row?.job,
    status: row?.status,
    job,
  });
}

async function legAdmission(): Promise<void> {
  const groupId = `walk-grp-${randomUUID().slice(0, 8)}`;
  const revision = 'rev-1';
  const past = new Date(Date.now() - 120_000).toISOString();
  const input = { group_id: groupId };
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
  await db
    .insert(paid_effect_control)
    .values({
      family: ADMISSION_FAMILY,
      backend: 'pg-boss',
      updated_at: new Date(),
    })
    .onConflictDoNothing();
  // Coordinator (family) receipt row: status 'waiting', receipt_ready.
  await db.insert(paid_effect).values({
    family: ADMISSION_FAMILY,
    entity_id: groupId,
    entity_revision: revision,
    unit: QUESTION_ADMISSION_PAID_UNIT,
    input_digest: digest,
    input_json: input,
    state: 'receipt_ready',
    result_json: { result: { status: 'waiting' } },
    result_recorded_at: new Date(),
  });
  // Stage waiting receipt with reason 'provider' — the changed SQL filter.
  await db.insert(paid_effect).values({
    family: ADMISSION_STAGE_FAMILY,
    entity_id: groupId,
    entity_revision: revision,
    unit: 'question_admission_stage',
    input_digest: digest,
    input_json: input,
    state: 'receipt_ready',
    result_json: {
      kind: 'waiting',
      recovery: { reason: 'provider', retry_at: past },
      input: input,
    },
    result_recorded_at: new Date(),
  });
  const boss = await getStartedBoss();
  const report = await recoverExpiredAdmissionWaits(db, { boss });
  log('admission_recovery', {
    groupId,
    scanned: report.scanned,
    rearmed: report.rearmed,
    skipped: report.skipped,
    budgetExhausted: report.budgetExhausted,
  });
}

async function legItemPrior(): Promise<void> {
  // Real runner packaging, only the provider swapped: per-run modelBinding pins
  // the real OpenDesign custom-provider route (hydrated into the registry).
  const { hydrateCustomProviders } = await import('@/core/config/server/custom-providers-hydrate');
  await hydrateCustomProviders(db);
  const result = await runItemPriorBackfillOperation(db, {
    method: 'feature',
    reps: 1,
    maxPerRun: 2,
    runTaskFn: makeRunTaskFn(db, {
      modelBinding: { provider: 'custom:opendesign', model: 'deepseek-v4.1-flash' },
    }),
  });
  log('item_prior', {
    considered: result.considered,
    calibrated: result.calibrated,
    skipped_failed: result.skipped_failed,
    providerWait: result.providerWait,
  });
}

const leg = process.argv[2] ?? 'all';
try {
  if (leg === 'note' || leg === 'all') await legNoteWait();
  if (leg === 'intervention' || leg === 'all') await legIntervention();
  if (leg === 'admission' || leg === 'all') await legAdmission();
  if (leg === 'item_prior' || leg === 'all') await legItemPrior();
} catch (err) {
  log('walk_failed', { leg, err: String(err) });
  process.exitCode = 1;
} finally {
  process.exit(process.exitCode ?? 0);
}
