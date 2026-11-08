import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentRunError } from '@/ai/agent-run-error';
import type { ProviderTransportEvidence, RequestSendState } from '@/ai/task-result';
import { taskInputHash } from '@/core/task-input-hash';
import { ai_task_runs, knowledge, paid_effect, question } from '@/db/schema';
import { readQuestionServing } from '@/kernel/read-models/question-serving';
import * as norm from '@/kernel/records/assessment-normalization';
import type { BoundRunTaskTextFn } from '@/server/ai/runner-fn';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { ADMISSION_FAMILY, admissionJobId } from '../server/admission/enqueue';
import { runAdmissionForQuestion as run } from './question_admission_run';

const bossSends: { name: string; data: unknown; opts: Record<string, unknown> }[] = [];
vi.mock('@/server/boss/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/boss/client')>()),
  getStartedBoss: async () => ({
    send: async (name: string, data: unknown, opts: Record<string, unknown>) => {
      bossSends.push({ name, data, opts });
      return 'wake-job-id';
    },
  }),
}));

const RAW =
  '{"id":"q","kind":"choice","prompt_md":"哪项是受控变量？","reference_md":"B","rubric_json":null,"choices_md":["坡度","水量","流速"],"judge_kind_override":null,"structured":null,"source":"web_sourced"}';

const request = (
  send_state: RequestSendState,
  http_status?: number,
): {
  seq: number;
  loop: 'root';
  fetch_invoked_at: string;
  send_state: RequestSendState;
  http_status?: number;
} => ({
  seq: 0,
  loop: 'root',
  fetch_invoked_at: new Date().toISOString(),
  send_state,
  ...(http_status !== undefined ? { http_status } : {}),
});

const transport = (
  send_state: ProviderTransportEvidence['send_state'],
  requests: ReturnType<typeof request>[],
  byState?: Partial<Record<RequestSendState, number>>,
): ProviderTransportEvidence => ({
  v: 1,
  budget: { task_timeout_ms: 60_000 },
  lane: 'undici_agent',
  send_state,
  totals: {
    requests: requests.length,
    dispatches: requests.length,
    by_state: {
      not_sent: 0,
      sent_without_response: 0,
      response_received: 0,
      unknown: 0,
      in_flight: 0,
      ...byState,
    },
  },
  requests,
  requests_seen: requests.length,
  requests_dropped: 0,
  captured_at: new Date().toISOString(),
});

async function insertRun(input: {
  kind?: string;
  payload: unknown;
  outcome: 'failure' | 'success';
  transport?: ProviderTransportEvidence;
  errorMessage?: string;
}): Promise<string> {
  const id = createId();
  await testDb()
    .insert(ai_task_runs)
    .values({
      id,
      task_kind: input.kind ?? 'QuestionAdmissionSolveTask',
      provider: 'custom:opendesign',
      model: 'deepseek-v4.1-flash',
      input_hash: taskInputHash(input.payload),
      status: input.outcome,
      usage_json: {
        inputTokens: 0,
        outputTokens: 0,
        ...(input.transport ? { transport: input.transport } : {}),
      },
      ...(input.outcome === 'failure'
        ? {
            cost_usd: 0,
            cost_basis: 'estimated',
            cost_ref: 'unbilled-provider-rejection:test',
          }
        : { cost_usd: 0.0001, cost_basis: 'reported', cost_ref: 'pricebook:test' }),
      ...(input.errorMessage ? { error_message: input.errorMessage } : {}),
      started_at: new Date(),
      finished_at: new Date(),
    });
  return id;
}

interface Seeded {
  groupId: string;
  revisionId: string;
  digest: string;
  publishEventId: string;
  unitId: string;
  correctItemId: string;
  wrongItemId: string;
}

/** One publication's full provenance chain: question+revision+lifecycle plus
 * the publish event the purpose binding anchors to. */
async function seedAdmission(opts: { compositeUnit?: boolean } = {}): Promise<Seeded> {
  const db = testDb();
  const contract = norm.normalizeQuestionRowToContract(
    JSON.parse(RAW) as norm.NormalizableQuestionRow,
  );
  contract.response_spec.slots[0].placement = { row: 0, col: 0, label: '1' };
  // A scored unit spanning more than one slot has no deterministic upgrade lane.
  if (opts.compositeUnit) {
    const refs = contract.scoring_basis.units[0].slot_refs;
    contract.scoring_basis.units[0].slot_refs = [...refs, ...refs];
  }
  const digest = norm.publishedContractSeal({
    structure: contract.structure,
    response_spec: contract.response_spec,
    scoring_basis: contract.scoring_basis,
    execution_plan: contract.execution_plan,
  }).canonical;
  const unit = contract.scoring_basis.units[0];
  const slot = contract.response_spec.slots[0];
  const options = slot.kind === 'single_choice' ? slot.options : [];
  const q = (layer: object) => JSON.stringify(layer).replaceAll("'", "''");
  await db.$client.unsafe(
    `insert into question (id,kind,prompt_md,source,created_at,updated_at) values ('q','choice','x','web_sourced',now(),now());
     insert into question_revision (revision_id,group_id,revision_ordinal,integrity_digest,structure,response_spec,scoring_basis,execution_plan,availability,published_at) values ('r','q',1,'${digest}','${q(contract.structure)}'::jsonb,'${q(contract.response_spec)}'::jsonb,'${q(contract.scoring_basis)}'::jsonb,'${q(contract.execution_plan)}'::jsonb,'general_pool',now());
     insert into question_group_lifecycle (group_id,current_revision_id,availability,scoring_admission_state,scoring_admission_withheld_reason,claim_policy,created_at,updated_at) values ('q','r','general_pool','withheld','unverified_rules','unbounded',now(),now());`,
  );
  const publishEventId = `pub-${createId()}`;
  await db.$client.unsafe(
    `insert into event (id,session_id,actor_kind,actor_ref,action,subject_kind,subject_id,outcome,payload,caused_by_event_id,task_run_id,cost_micro_usd,created_at,ingest_at)
     values ('${publishEventId}',null,'system','quiz_gen:persist','experimental:assessment_publish','question','q','success','{"group_id":"q","revision_id":"r","integrity_digest":"${digest}"}'::jsonb,null,null,null,now(),now())`,
  );
  return {
    groupId: 'q',
    revisionId: 'r',
    digest,
    publishEventId,
    unitId: unit.scoring_unit_id,
    // reference 'B' is the second option.
    correctItemId: options[1]?.option_id ?? '',
    wrongItemId: options[0]?.option_id ?? '',
  };
}

let fixtureBoss: PgBoss | undefined;
const ownedJobs: Array<{ name: string; id: string }> = [];

async function ensureBoss(): Promise<PgBoss> {
  if (!fixtureBoss) {
    const url = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
    if (
      !/^\/test_fork_\d+$/.test(url.pathname) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      throw new Error('Disposable fork DB required');
    fixtureBoss = new PgBoss({
      connectionString: url.toString(),
      max: 2,
      supervise: false,
      schedule: false,
    });
    fixtureBoss.on('error', () => {});
    await fixtureBoss.start();
  }
  return fixtureBoss;
}

/** The live pgboss.job row the delivery fence locks; a purpose binding only
 * exists for a delivery that could have initiated spend — recovery wakes own
 * none. Rows land through a real fixture install: hand-built pgboss objects
 * abort pg-boss's own install script and poison the fork for other files. */
async function insertDelivery(
  seed: Seeded,
  deliveryId: string,
  jobData: object,
  options: { binding?: boolean } = {},
) {
  const boss = await ensureBoss();
  await boss.createQueue(ADMISSION_FAMILY);
  const jobId = await boss.send(ADMISSION_FAMILY, jobData, { id: deliveryId, retryLimit: 0 });
  if (jobId !== deliveryId) throw new Error('Fixture job was not enqueued');
  ownedJobs.push({ name: ADMISSION_FAMILY, id: jobId });
  const [job] = await boss.fetch(ADMISSION_FAMILY, { includeMetadata: true });
  if (job?.id !== deliveryId || job.state !== 'active')
    throw new Error('Fixture must fetch the exact job into active state');
  if (options.binding === false) return;
  await testDb().$client.unsafe(
    `insert into event (id,session_id,actor_kind,actor_ref,action,subject_kind,subject_id,outcome,payload,caused_by_event_id,task_run_id,cost_micro_usd,created_at,ingest_at)
     values ('question-admission-purpose:${deliveryId}',null,'system','practice:question_admission','experimental:question_admission_purpose','question','${seed.groupId}','success','${JSON.stringify(
       {
         version: 1,
         job_id: deliveryId,
         source_event_id: seed.publishEventId,
         usage_source_event_id: null,
         question_id: seed.groupId,
         revision_id: seed.revisionId,
         revision_digest: seed.digest,
         derivation_policy: 'answer_only',
       },
     )}'::jsonb,null,null,null,now(),now())`,
  );
}

function jobData(seed: Seeded, extra: object = {}) {
  return {
    admission_version: 4 as const,
    question_id: seed.groupId,
    revision_id: seed.revisionId,
    expected_revision_digest: seed.digest,
    expected_admission_generation: 0,
    dispatch_generation: 0,
    source_event_id: seed.publishEventId,
    ...extra,
  };
}

function solveOutput(unitId: string, itemId: string) {
  return {
    units: [
      {
        scoring_unit_id: unitId,
        status: 'solved',
        answer: { kind: 'select', item_ids: [itemId] },
      },
    ],
  };
}

type Failure =
  | { readonly kind: 'bound'; readonly status: number }
  | {
      readonly kind: 'transport';
      readonly state: 'not_sent' | 'unknown' | 'sent_without_response';
      readonly subtype?: string;
    }
  | { readonly kind: 'validation' };

interface FakeTask {
  task: BoundRunTaskTextFn;
  calls: { kind: string }[];
}

function fakeTaskFactory(
  seed: Seeded,
  overrides: {
    failures?: Map<number, Failure>;
    successAnswers?: Map<number, string>;
  } = {},
): FakeTask {
  const failures = overrides.failures ?? new Map();
  const successAnswers = overrides.successAnswers ?? new Map();
  const calls: { kind: string }[] = [];
  const task: BoundRunTaskTextFn = async (kind, payload, ctx) => {
    const index = calls.filter((call) => call.kind === kind).length;
    calls.push({ kind });
    const runId = `probe-${calls.length}`;
    await ctx?.beforeProviderQuery?.({
      taskRunId: runId,
      provider: 'custom:opendesign',
      model: 'deepseek-v4.1-flash',
    });
    const failure = failures.get(index);
    if (failure) {
      if (failure.kind === 'bound') {
        const taskRunId = await insertRun({
          kind,
          payload,
          outcome: 'failure',
          transport: transport('response_received', [request('response_received', failure.status)]),
        });
        throw new AgentRunError({
          kind,
          taskRunId,
          subtype: 'api_error_result',
          apiErrorStatus: failure.status,
          errors: [`provider ${failure.status}`],
        });
      }
      if (failure.kind === 'transport') {
        const taskRunId = await insertRun({
          kind,
          payload,
          outcome: 'failure',
          transport: transport(failure.state, [request(failure.state)]),
        });
        throw new AgentRunError({
          kind,
          taskRunId,
          subtype: (failure.subtype ?? 'error_during_execution') as
            | 'error_during_execution'
            | 'budget_timeout',
          errors: ['connection dropped'],
        });
      }
      const taskRunId = await insertRun({ kind, payload, outcome: 'failure' });
      throw new AgentRunError({
        kind,
        taskRunId,
        subtype: 'error_max_structured_output_retries',
        errors: ['could not produce output'],
      });
    }
    const taskRunId = await insertRun({ kind, payload, outcome: 'success' });
    const answer = successAnswers.get(index) ?? seed.correctItemId;
    const output = solveOutput(seed.unitId, answer);
    return {
      text: JSON.stringify(output),
      structured_output: output,
      task_run_id: taskRunId,
      cost_usd: 0.0001,
    };
  };
  return { task, calls };
}

async function stageRows() {
  return testDb()
    .select({
      unit: paid_effect.unit,
      state: paid_effect.state,
      input: paid_effect.input_json,
      result: paid_effect.result_json,
    })
    .from(paid_effect)
    .where(eq(paid_effect.family, 'question_admission_stage'));
}

async function deniedEvents(groupId: string) {
  return (await testDb().$client.unsafe(
    `select id from event where action = 'experimental:question_admission_purpose_denied' and subject_id = '${groupId}'`,
  )) as unknown[];
}

async function servingAdmission(groupId: string) {
  const serving = await readQuestionServing(testDb(), [groupId]);
  return serving.byId.get(groupId)?.admission;
}

/** Deliver the deterministic wake the coordinator scheduled: the same frozen
 * jobData, a fresh job id, and no purpose binding — exactly what the real
 * recovery delivery looks like to the purpose gate. */
async function deliverWake(
  seed: Seeded,
  data: ReturnType<typeof jobData>,
  task: BoundRunTaskTextFn,
) {
  const wakeId = admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:wake`, 0);
  const wakeData = { ...data, recovery_confirmed: false };
  await insertDelivery(seed, wakeId, wakeData, { binding: false });
  await testDb().$client.unsafe(
    `update paid_effect set result_json = jsonb_set(result_json, '{recovery,retry_at}', '"2020-01-01T00:00:00.000Z"')
     where family = 'question_admission_stage' and result_json->>'kind' = 'waiting'`,
  );
  return run(testDb(), wakeData, { id: wakeId, jobData: wakeData }, { runTask: task });
}

afterAll(async () => {
  await fixtureBoss?.stop();
});

describe('question admission provider recovery', () => {
  beforeEach(async () => {
    process.env.ADMISSION_PROVIDER_RETRY_MAX_RETRIES = '1';
    process.env.ADMISSION_PROVIDER_RETRY_BASE_DELAY_MS = '0';
    await resetDb();
    bossSends.length = 0;
    return () => {
      delete process.env.ADMISSION_PROVIDER_RETRY_MAX_RETRIES;
      delete process.env.ADMISSION_PROVIDER_RETRY_BASE_DELAY_MS;
    };
  });
  afterEach(async () => {
    for (const job of ownedJobs.splice(0)) await fixtureBoss?.deleteJob(job.name, job.id);
  });

  // @invariant concurrency: a provably unbilled provider rejection waits on a
  // durable receipt and replays under the same paid identity — the wake is
  // scheduled through pg-boss, writes no purpose denial, and completes the
  // admission without a second paid send for the same content
  // @fails-if a bound 5xx lands a terminal receipt, the recovered run
  // double-pays, a recovery delivery writes a purpose_denied event, or the
  // serving read stops saying pending while the wake is still armed
  it('a bound provider 500 waits and the scheduled wake completes the same paid effect', async () => {
    const db = testDb();
    const seed = await seedAdmission();
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task } = fakeTaskFactory(seed, {
      failures: new Map([
        [0, { kind: 'bound', status: 500 }],
        [1, { kind: 'bound', status: 500 }],
      ]),
    });

    const first = await run(db, data, { id: d1, jobData: data }, { runTask: task });
    expect(first.status).toBe('waiting');
    const stages = await stageRows();
    const waiting = stages.find(
      (row) => (row.result as { kind?: string } | null)?.kind === 'waiting',
    );
    const waitingRecovery = (waiting?.result as { recovery?: { reason: string } } | undefined)
      ?.recovery;
    expect(waitingRecovery?.reason).toBe('provider');
    const wake = bossSends.find((send) => send.name === 'question_admission_run');
    expect(wake).toBeDefined();
    const wakeData = wake?.data as { recovery_confirmed?: boolean } | undefined;
    expect(wakeData?.recovery_confirmed).toBe(false);
    expect((await servingAdmission(seed.groupId))?.status).toBe('pending');
    expect((await servingAdmission(seed.groupId))?.wait?.reason).toBe('provider');

    const second = await deliverWake(seed, data, task);
    expect(second.status).toBe('admitted');
    expect(await deniedEvents(seed.groupId)).toHaveLength(0);
    expect((await servingAdmission(seed.groupId))?.status).toBe('admitted');
    // The recovered send replayed call 0's chain as its next attempt; no
    // fresh paid call index was minted for the same lane.
    const units = (await stageRows()).map((row) => row.unit);
    expect(units).toContain('call:0:attempt:2');
    expect(new Set(units).size).toBe(units.length);
  });

  // @invariant concurrency: transport-proven not_sent waits on the same durable
  // fence — the burst ladder owns the wake cadence and the due resend replays
  // the paid chain instead of buying a new effect
  // @fails-if a not_sent verdict lands terminal, or the resend creates a new
  // paid effect instead of replaying the chain
  it('a transport-proven not_sent failure waits and the due wake resends', async () => {
    const db = testDb();
    const seed = await seedAdmission();
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task } = fakeTaskFactory(seed, {
      failures: new Map([
        [0, { kind: 'transport', state: 'not_sent' }],
        // A budget-timeout rejection carries the same provably-unsent evidence.
        [1, { kind: 'transport', state: 'not_sent', subtype: 'budget_timeout' }],
      ]),
    });

    const first = await run(db, data, { id: d1, jobData: data }, { runTask: task });
    expect(first.status).toBe('waiting');
    const waiting = (await stageRows()).find(
      (row) => (row.result as { kind?: string } | null)?.kind === 'waiting',
    );
    const waitingRecovery = (waiting?.result as { recovery?: { reason: string } } | undefined)
      ?.recovery;
    expect(waitingRecovery?.reason).toBe('not_sent');

    const second = await deliverWake(seed, data, task);
    expect(second.status).toBe('admitted');
    expect(await deniedEvents(seed.groupId)).toHaveLength(0);
  });

  // @invariant concurrency: a bound 429 parks on the quota wait — the durable
  // receipt carries the quota reason to the read model and the due wake
  // replays the paid chain after the congestion clears
  // @fails-if a bound 429 lands terminal, or the wake re-mints a paid call
  it('a bound provider 429 waits on the quota lane and the due wake resends', async () => {
    const db = testDb();
    const seed = await seedAdmission();
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task } = fakeTaskFactory(seed, {
      failures: new Map([
        [0, { kind: 'bound', status: 429 }],
        [1, { kind: 'bound', status: 429 }],
      ]),
    });

    const first = await run(db, data, { id: d1, jobData: data }, { runTask: task });
    expect(first.status).toBe('waiting');
    const waiting = (await stageRows()).find(
      (row) => (row.result as { kind?: string } | null)?.kind === 'waiting',
    );
    const waitingRecovery = (waiting?.result as { recovery?: { reason: string } } | undefined)
      ?.recovery;
    expect(waitingRecovery?.reason).toBe('quota');
    expect((await servingAdmission(seed.groupId))?.wait?.reason).toBe('quota');

    const second = await deliverWake(seed, data, task);
    expect(second.status).toBe('admitted');
    expect(await deniedEvents(seed.groupId)).toHaveLength(0);
  });

  // @invariant concurrency: a bound 401 is a complete pre-billing refusal on
  // the paid lane — it parks on the provider wait clock until the credential
  // is renewed instead of landing terminal, and the due wake resends under
  // the same paid identity
  // @fails-if a bound 401 lands a terminal receipt, or the resend mints a new
  // paid call
  it('a bound provider 401 waits on the provider lane and the due wake resends', async () => {
    const db = testDb();
    const seed = await seedAdmission();
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task } = fakeTaskFactory(seed, {
      failures: new Map([[0, { kind: 'bound', status: 401 }]]),
    });

    const first = await run(db, data, { id: d1, jobData: data }, { runTask: task });
    expect(first.status).toBe('waiting');
    const waiting = (await stageRows()).find(
      (row) => (row.result as { kind?: string } | null)?.kind === 'waiting',
    );
    const waitingRecovery = (waiting?.result as { recovery?: { reason: string } } | undefined)
      ?.recovery;
    expect(waitingRecovery?.reason).toBe('provider');
    expect((await servingAdmission(seed.groupId))?.wait?.reason).toBe('provider');
    expect((await servingAdmission(seed.groupId))?.wait?.recovery_action).toBe('wait_for_retry');

    const second = await deliverWake(seed, data, task);
    expect(second.status).toBe('admitted');
    expect(await deniedEvents(seed.groupId)).toHaveLength(0);
  });

  // @invariant data: a scored unit the converter cannot upgrade (a composite
  // cross-slot unit) is a terminal content failure — the admission resolves
  // before any provider call, so no wait receipt is written, no wake is
  // armed, and no paid call is made
  // @fails-if a content-terminal question arms a wait or spends a provider call
  it('a content validation failure lands terminal failed with no wait armed', async () => {
    const db = testDb();
    const seed = await seedAdmission({ compositeUnit: true });
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task, calls } = fakeTaskFactory(seed);

    const first = await run(db, data, { id: d1, jobData: data }, { runTask: task });
    expect(first.status).toBe('withheld');
    expect(calls).toHaveLength(0);
    expect(
      (await stageRows()).some(
        (row) => (row.result as { kind?: string } | null)?.kind === 'waiting',
      ),
    ).toBe(false);
    expect(bossSends.some((send) => send.name === 'question_admission_run')).toBe(false);
    expect((await servingAdmission(seed.groupId))?.status).toBe('failed');
    expect((await servingAdmission(seed.groupId))?.wait ?? null).toBeNull();
  });

  // @invariant data: an outcome the transport cannot prove never resends — a
  // resent uncertain call can double-bill, so the paid effect stays unknown,
  // a redelivery holds, and the read model reports outcome_unconfirmed
  // @fails-if an unknown attempt is resent, or the learner-facing read claims
  // the admission is still checking
  it('an unprovable send outcome marks unknown and never resends', async () => {
    const db = testDb();
    const seed = await seedAdmission();
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task, calls } = fakeTaskFactory(seed, {
      failures: new Map([[0, { kind: 'transport', state: 'unknown' }]]),
    });

    // The uncertain outcome is fenced before any resend: the stage marks its
    // paid effect unknown and the original error escapes the delivery.
    await expect(run(db, data, { id: d1, jobData: data }, { runTask: task })).rejects.toThrow();
    const sends = calls.length;
    expect((await stageRows()).some((row) => row.state === 'unknown')).toBe(true);
    expect((await servingAdmission(seed.groupId))?.status).toBe('undecided');
    expect((await servingAdmission(seed.groupId))?.cause).toBe('outcome_unconfirmed');

    const retryId = admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:retry`, 0);
    await insertDelivery(seed, retryId, data, { binding: false });
    const second = await run(db, data, { id: retryId, jobData: data }, { runTask: task });
    expect(second.status).toBe('pending');
    expect(calls.length).toBe(sends);
  });

  // @invariant concurrency: a spent bounded wait drops to the outage tail —
  // the durable receipt still arms a wake on the slow cadence and every resend
  // re-passes the unbilled gate, so a long outage costs no terminal state and
  // no unbounded spend
  // @fails-if the spent ladder writes a terminal exhausted receipt, or the
  // tail wait stops arming a wake
  it('a spent provider wait ladder drops to the outage tail instead of a terminal receipt', async () => {
    const db = testDb();
    const seed = await seedAdmission();
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task } = fakeTaskFactory(seed, {
      failures: new Map([
        [0, { kind: 'bound', status: 500 }],
        [1, { kind: 'bound', status: 500 }],
        [2, { kind: 'bound', status: 500 }],
      ]),
    });
    await run(db, data, { id: d1, jobData: data }, { runTask: task });

    // The ladder is spent: the latest wait already holds provider_waits 8.
    await testDb().$client.unsafe(
      `update paid_effect set result_json = jsonb_set(result_json, '{provider_waits}', '8')
       where family = 'question_admission_stage' and result_json->>'kind' = 'waiting'`,
    );
    const tail = await deliverWake(seed, data, task);
    expect(tail.status).toBe('waiting');
    const tailReceipt = (await stageRows())
      .map(
        (row) =>
          row.result as {
            kind?: string;
            recovery?: { reason: string; retry_at: string };
            provider_waits?: number;
            outage_waits?: number;
          } | null,
      )
      .find((row) => row?.kind === 'waiting' && (row.outage_waits ?? 0) > 0);
    expect(tailReceipt).toBeDefined();
    expect(tailReceipt?.provider_waits).toBe(9);
    expect(tailReceipt?.outage_waits).toBe(1);
    const retryAtMs = Date.parse(tailReceipt?.recovery?.retry_at ?? '');
    expect(retryAtMs - Date.now()).toBeGreaterThan(3 * 60 * 60_000);
    expect((await servingAdmission(seed.groupId))?.status).toBe('pending');
  });
});

describe('question admission subject freeze', () => {
  // @invariant grading: the subject profile an admission freezes and sends to the solver is the enrollment subject first, then the domain of knowledge_ids[0], then general — so a later knowledge tag cannot change the subject of the same question
  // @fails-if a question with an enrollment subject freezes its knowledge domain or general, or a question without one stops falling back to knowledge_ids[0] and then general
  it.each([
    {
      name: 'enrollment subject, no knowledge',
      enrolled: 'physics',
      domain: null,
      want: 'physics',
    },
    {
      name: 'enrollment subject beats knowledge',
      enrolled: 'physics',
      domain: 'math',
      want: 'physics',
    },
    { name: 'no enrollment subject, knowledge', enrolled: null, domain: 'math', want: 'math' },
    { name: 'neither', enrolled: null, domain: null, want: 'general' },
  ])('$name freezes $want', async ({ enrolled, domain, want }) => {
    await resetDb();
    const db = testDb();
    const seed = await seedAdmission();
    const now = new Date();
    if (domain) {
      await db
        .insert(knowledge)
        .values({ id: 'k-subject', name: 'Node', domain, created_at: now, updated_at: now });
    }
    await db
      .update(question)
      .set({
        knowledge_ids: domain ? ['k-subject'] : [],
        metadata: enrolled ? { ingestion_enrollment: { subject_id: enrolled } } : {},
      })
      .where(eq(question.id, seed.groupId));
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task } = fakeTaskFactory(seed);
    const sent: Array<string | undefined> = [];
    const observed: BoundRunTaskTextFn = (kind, payload, ctx) => {
      sent.push(ctx?.subjectProfile?.id);
      return task(kind, payload, ctx);
    };

    await run(db, data, { id: d1, jobData: data }, { runTask: observed });
    for (const job of ownedJobs.splice(0)) await fixtureBoss?.deleteJob(job.name, job.id);

    const frozen = await db
      .select({ input: paid_effect.input_json })
      .from(paid_effect)
      .where(eq(paid_effect.family, ADMISSION_FAMILY));
    expect({
      frozen: frozen.map(
        (row) => (row.input as { subject_profile: { id: string } }).subject_profile.id,
      ),
      sent: [...new Set(sent)],
    }).toEqual({ frozen: [want], sent: [want] });
  });
});
