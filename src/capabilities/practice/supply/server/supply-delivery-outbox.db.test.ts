// Supply deliveries on a real Postgres + real pg-boss: each producer commits its intent with the
// business write, sends after commit, and the owning cron drain closes every crash window.
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { event, knowledge } from '@/db/schema';
import { EvidenceDemandV1 } from '@/kernel/supply-contracts';
import { _resetBossForTests, getStartedBoss } from '@/server/boss/client';
import { EXPIRE_AGENT, EXPIRE_LLM, createJobQueue } from '@/server/boss/queue-config';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { insertLegacyGoal } from '../../../../../tests/helpers/legacy-goal';
import {
  dispatchPlacementStarterClaim,
  drainPlacementStarterDeliveries,
} from './placement-starter';
import { buildPlacementStarterRecoveryHandler } from './placement-starter-recovery';
import { materializePlacementStartersForGoal } from './placement-starter-store';
import { buildQuestionPreparerTarget } from './preparer-target';
import { runQuestionPreparer } from './question-preparer';
import {
  buildQuestionPreparerRecoveryHandler,
  drainQuestionPreparerDeliveries,
  preparerRecord,
  recoverQuestionPreparer,
} from './question-preparer-journal';
import { enqueueQuestionPreparerTicket } from './question-preparer-ticket';
import {
  SUPPLY_DELIVERY_INTENT_ACTION,
  type SupplyDeliveryBoss,
  supplyDeliveryReceiptId,
} from './supply-delivery-outbox';

const db = testDb();
let boss: Awaited<ReturnType<typeof getStartedBoss>>;
const QUEUES = ['quiz_gen', 'supply_execute', 'question_preparer_run'] as const;

beforeAll(async () => {
  _resetBossForTests();
  boss = await getStartedBoss();
  await createJobQueue(boss, 'quiz_gen', EXPIRE_LLM);
  await createJobQueue(boss, 'supply_execute', EXPIRE_AGENT);
  await createJobQueue(boss, 'question_preparer_run', EXPIRE_LLM);
});

afterAll(async () => {
  vi.restoreAllMocks();
  for (const queue of QUEUES) await boss.deleteAllJobs(queue);
  await boss.stop({ graceful: false, timeout: 1_000 });
  _resetBossForTests();
});

const TICKET = EvidenceDemandV1.parse({
  version: 1,
  demand_id: 'demand:test:delivery',
  policy_version: 'supply-v2-phase-a',
  subject_id: 'math',
  claim: { kind: 'knowledge_mastery', statement: '分类讨论', knowledge_ids: ['k_param'] },
  evidence: { observables: ['分类正确'], minimum_observations: 1 },
  task: { kinds: ['choice'], allowed_uses: ['practice'] },
  difficulty: { band: 'near', scale: 'loom_difficulty_1_5', target_value: null },
  inventory_goal: { eligible_count: 1, horizon_days: 7 },
  control: { needed_by: null, max_budget_micro_usd: 100000, max_attempts: 1 },
  causes: [{ kind: 'coverage_gap' }],
});
const SEGMENT = { ticket: TICKET, ticket_event_id: 'ticket-event-1' };

async function seedKnowledge(): Promise<void> {
  const now = new Date('2026-07-23T00:00:00Z');
  await db.insert(knowledge).values([
    {
      id: 'seed:yuwen:root',
      name: '语文',
      domain: 'yuwen',
      parent_id: null,
      created_at: now,
      updated_at: now,
    },
    {
      id: 'kc-explicit',
      name: '文言实词',
      domain: null,
      parent_id: 'seed:yuwen:root',
      created_at: now,
      updated_at: now,
    },
    {
      id: 'k_root',
      name: '数学',
      domain: 'math',
      parent_id: null,
      created_at: now,
      updated_at: now,
    },
    {
      id: 'k_param',
      name: '含参函数单调性讨论',
      domain: null,
      parent_id: 'k_root',
      created_at: now,
      updated_at: now,
    },
  ]);
}

async function seedPlacementClaim(): Promise<string> {
  const now = new Date('2026-07-23T00:00:00Z');
  const row = {
    id: 'goal-1',
    title: '读懂古文',
    subject_id: 'yuwen',
    scope_knowledge_ids: ['kc-explicit'],
    scope_mode: 'explicit' as const,
    sequence_hint: 0,
    source: 'manual' as const,
  };
  await insertLegacyGoal(db, { ...row, now });
  await db.insert(event).values({
    id: 'goal-genesis-1',
    actor_kind: 'system',
    actor_ref: 'goal-create',
    action: 'experimental:genesis',
    subject_kind: 'goal',
    subject_id: 'goal-1',
    outcome: 'success',
    payload: {
      row: {
        ...row,
        status: 'active',
        source_ref: null,
        created_at: now,
        updated_at: now,
        version: 0,
      },
    },
    created_at: now,
  });
  const { identities } = await db.transaction((tx) =>
    materializePlacementStartersForGoal(tx, 'goal-1'),
  );
  const claimId = identities[0]?.claimId;
  if (!claimId) throw new Error('missing placement identity');
  return claimId;
}

interface Producer {
  name: string;
  queue: (typeof QUEUES)[number];
  /** Seeds state and returns engine job ids that exist before the producer runs. */
  seed(): Promise<string[]>;
  produce(): Promise<unknown>;
  drain(boss: SupplyDeliveryBoss): Promise<{ scanned: number }>;
  cron(): Promise<unknown>;
}

let seeded = '';
const PRODUCERS: Producer[] = [
  {
    name: 'placement starter claim',
    queue: 'supply_execute',
    async seed() {
      seeded = await seedPlacementClaim();
      return [];
    },
    produce: () => dispatchPlacementStarterClaim(db, seeded),
    drain: (b) => drainPlacementStarterDeliveries(db, b),
    cron: () => buildPlacementStarterRecoveryHandler(db, { placementProbeEnabled: false })([]),
  },
  {
    name: 'preparer gap ticket',
    queue: 'question_preparer_run',
    async seed() {
      return [];
    },
    produce: () =>
      enqueueQuestionPreparerTicket(
        db,
        TICKET,
        buildQuestionPreparerTarget(TICKET, { reason: 't' }),
      ),
    drain: (b) => drainQuestionPreparerDeliveries(db, b),
    cron: () => buildQuestionPreparerRecoveryHandler(db)(),
  },
  {
    name: 'preparer segment deferred behind a live prior',
    queue: 'question_preparer_run',
    async seed() {
      const prior = randomUUID();
      await preparerRecord(db, prior, SEGMENT, 'unstarted');
      await boss.send('question_preparer_run', SEGMENT, { id: prior });
      return [prior];
    },
    produce: () => runQuestionPreparer(db, randomUUID(), SEGMENT),
    drain: (b) => drainQuestionPreparerDeliveries(db, b),
    cron: () => buildQuestionPreparerRecoveryHandler(db)(),
  },
  {
    name: 'preparer recovery of a dead segment',
    queue: 'question_preparer_run',
    async seed() {
      seeded = randomUUID();
      await preparerRecord(db, seeded, SEGMENT, 'unstarted');
      return [];
    },
    produce: () => recoverQuestionPreparer(db, seeded),
    drain: (b) => drainQuestionPreparerDeliveries(db, b),
    cron: () => buildQuestionPreparerRecoveryHandler(db)(),
  },
];

async function intents() {
  return db
    .select({ subject: event.subject_id, payload: event.payload })
    .from(event)
    .where(eq(event.action, SUPPLY_DELIVERY_INTENT_ACTION));
}

async function engineJobs(queue: string, exclude: string[]) {
  const rows = await db.execute<{ id: string; data: unknown }>(
    sql`SELECT id::text AS id, data FROM pgboss.job WHERE name = ${queue}`,
  );
  return [...rows].filter((row) => !exclude.includes(row.id));
}

async function accepted(jobId: string): Promise<boolean> {
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(eq(event.id, supplyDeliveryReceiptId('accepted', jobId)));
  return rows.length === 1;
}

/** The business transaction writes everything, then COMMIT itself fails. */
async function failingCommit(run: () => Promise<unknown>): Promise<void> {
  await db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION supply_delivery_commit_fault() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'business commit aborted'; END $$`),
  );
  await db.execute(
    sql.raw(`CREATE CONSTRAINT TRIGGER supply_delivery_commit_fault AFTER INSERT ON event
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.action = '${SUPPLY_DELIVERY_INTENT_ACTION}')
      EXECUTE FUNCTION supply_delivery_commit_fault()`),
  );
  try {
    await expect(run()).rejects.toThrow();
  } finally {
    await db.execute(sql.raw('DROP TRIGGER IF EXISTS supply_delivery_commit_fault ON event'));
    await db.execute(sql.raw('DROP FUNCTION IF EXISTS supply_delivery_commit_fault()'));
  }
}

// @invariant concurrency: a supply delivery commits with its business write and reaches the engine exactly once under its bound id, whichever side of the commit/send/ack windows the process dies on
// @fails-if a rolled-back write is sent, a committed intent is lost when the send fails, a crash after acceptance mints a second job, or overlapping cron drains enqueue twice
it.each(PRODUCERS)('$name: rollback, crash windows and concurrent drains', async (row) => {
  const send = boss.send.bind(boss);
  for (const scenario of [
    'rollback',
    'crash_before_send',
    'crash_after_accept',
    'concurrent_drains',
  ] as const) {
    await resetDb();
    for (const queue of QUEUES) await boss.deleteAllJobs(queue);
    await seedKnowledge();
    const before = await row.seed();
    const label = `${row.name} / ${scenario}`;

    if (scenario === 'rollback') {
      await failingCommit(row.produce);
      expect(await intents(), label).toHaveLength(0);
      expect((await row.drain(boss)).scanned, label).toBe(0);
      expect(await engineJobs(row.queue, before), label).toHaveLength(0);
      continue;
    }

    const spy = vi.spyOn(boss, 'send');
    if (scenario === 'crash_after_accept') {
      spy.mockImplementationOnce(async (...args: Parameters<typeof send>) => {
        await send(...args);
        throw new Error('process died after the engine accepted');
      });
    } else {
      spy.mockRejectedValueOnce(new Error('engine unreachable'));
    }
    await row.produce();
    spy.mockRestore();

    const [intent] = await intents();
    const jobId = String(intent?.payload.job_id);
    expect(await accepted(jobId), label).toBe(false);
    expect(await engineJobs(row.queue, before), label).toHaveLength(
      scenario === 'crash_after_accept' ? 1 : 0,
    );

    if (scenario === 'concurrent_drains') await Promise.all([row.cron(), row.cron()]);
    else await row.cron();

    const jobs = await engineJobs(row.queue, before);
    expect(
      jobs.map((job) => job.id),
      label,
    ).toEqual([jobId]);
    expect(jobs[0]?.data, label).toEqual(intent?.payload.data);
    expect(await accepted(jobId), label).toBe(true);
  }
});
