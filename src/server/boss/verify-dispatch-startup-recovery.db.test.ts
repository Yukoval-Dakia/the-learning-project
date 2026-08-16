// YUK-891 — regression: the verify-dispatch startup recovery must never send
// into a not-yet-created verifier queue. Before YUK-868, quiz_verify /
// source_verify were created by the central ledger (registerHandlers); after
// the manifest move they are created by registerCapabilityJobs, which runs
// AFTER registerHandlers. Pre-fix, the startup trigger fired at the end of
// registerHandlers, so the already-polling verify_dispatch_recover worker
// could execute the recovery while the registrar was still mounting and the
// first boss.send('quiz_verify'|'source_verify') threw pg-boss's
// `Queue <name> does not exist` — the first attempt failed noisily (failure
// metric event + rolled-back intents) and the drain was delayed to the
// nightly cron.
//
// This file reproduces the production boot sequence against a FRESH pg-boss
// schema (job-observation-boss-contract precedent) with pre-existing durable
// verify intents, then proves the first recovery execution enqueues both
// intents with zero failure metric events.

import { and, eq, inArray } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { practiceCapability } from '@/capabilities/practice/manifest';
import { db } from '@/db/client';
import { event, question } from '@/db/schema';
import type { CapabilityManifest } from '@/kernel/manifest';
import { resetDb } from '../../../tests/helpers/db';
import { registerHandlers } from './handlers';
import { registerCapabilityJobs } from './register-capability-jobs';
import {
  VERIFY_DISPATCH_COMPLETE_ACTION,
  sendVerifyDispatchStartupRecovery,
  writeVerifyDispatchIntent,
} from './verify-dispatch-outbox';

const TEST_SCHEMA = 'pgboss_yuk891_startup_recovery';

let boss: PgBoss;
let sqlClient: ReturnType<typeof postgres>;

// Mount ONLY the two practice verifier decls, with inert handler factories:
// the registrar still builds the exact production queues (the decl tier drives
// createJobQueue's AGENT recipe), but executing a real verifier's LLM pipeline
// in a DB test is out of scope — the recovery's enqueue is what this file locks.
// Mounting the rest of practice's decls would only add idle workers + stray
// cron schedules that could fire real handlers mid-test.
const inertLoad = async () => () => async () => undefined;
const verifierOnlyPractice: CapabilityManifest = {
  ...practiceCapability,
  jobs: {
    handlers: (practiceCapability.jobs?.handlers ?? [])
      .filter((decl) => decl.name === 'quiz_verify' || decl.name === 'source_verify')
      .map((decl) => ({ ...decl, load: () => inertLoad() })),
  },
};

async function seedDraftWithIntent(
  questionId: string,
  source: 'quiz_gen' | 'web_sourced',
  verifier: 'quiz_verify' | 'source_verify',
) {
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: questionId,
    source,
    draft_status: 'draft',
    created_at: new Date(),
    updated_at: new Date(),
  });
  await writeVerifyDispatchIntent(db, { questionId, verifier });
}

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL required');
  sqlClient = postgres(connectionString, { max: 1 });
  // Fresh pg-boss schema for this run (also cleans watch-mode re-runs): the
  // regression requires the verifier queues to NOT exist when boot starts.
  await sqlClient.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  boss = new PgBoss({ connectionString, schema: TEST_SCHEMA, max: 2 });
  await boss.start();
}, 60_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  if (sqlClient) {
    await sqlClient.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await sqlClient.end();
  }
});

describe('verify-dispatch startup recovery vs capability queue creation (YUK-891)', () => {
  beforeEach(async () => {
    await resetDb();
    await seedDraftWithIntent('q-yuk891-quiz', 'quiz_gen', 'quiz_verify');
    await seedDraftWithIntent('q-yuk891-src', 'web_sourced', 'source_verify');
  });

  it('enqueues durable verify intents on the FIRST startup recovery execution (no missing-queue send)', async () => {
    // Boot segment 1 — central ledger: mounts the verify_dispatch_recover worker
    // (already polling) and, post-YUK-891, fires NO startup trigger.
    await registerHandlers(boss, db);

    // Regression precondition, proven live: at this point in boot the
    // practice-owned verifier queues do not exist, and a send into one is
    // exactly the pre-fix first-execution failure (getQueueCache throw —
    // raised before any SQL, so this probe has no side effects).
    expect(await boss.getQueue('quiz_verify')).toBeNull();
    expect(await boss.getQueue('source_verify')).toBeNull();
    await expect(boss.send('quiz_verify', { probe: 'missing-queue' })).rejects.toThrow(
      'Queue quiz_verify does not exist',
    );
    const beforeTrigger = await sqlClient.unsafe<[{ n: number }]>(
      `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.job WHERE name = 'verify_dispatch_recover'`,
    );
    expect(beforeTrigger[0]?.n).toBe(0);

    // Boot segment 2 — capability registrar creates the verifier queues.
    await registerCapabilityJobs(boss, db, [verifierOnlyPractice]);
    expect(await boss.getQueue('quiz_verify')).not.toBeNull();
    expect(await boss.getQueue('source_verify')).not.toBeNull();

    // Boot segment 3 — two consecutive startup triggers, matching two completed boots.
    // The standard-policy recovery queue deliberately receives both; idempotence lives
    // in the durable-intent recovery handler rather than an inert singletonKey option.
    await sendVerifyDispatchStartupRecovery(boss);
    await sendVerifyDispatchStartupRecovery(boss);

    const startupTriggers = await sqlClient.unsafe<[{ n: number }]>(
      `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.job WHERE name = 'verify_dispatch_recover'`,
    );
    expect(startupTriggers[0]?.n).toBe(2);

    // The recovery worker executes: both durable intents complete as enqueued.
    const subjectIds = ['q-yuk891-quiz', 'q-yuk891-src'];
    const deadline = Date.now() + 20_000;
    let completions: { subjectId: string; payload: unknown }[] = [];
    while (Date.now() < deadline) {
      completions = await db
        .select({ subjectId: event.subject_id, payload: event.payload })
        .from(event)
        .where(
          and(
            inArray(event.subject_id, subjectIds),
            eq(event.action, VERIFY_DISPATCH_COMPLETE_ACTION),
            eq(event.outcome, 'success'),
          ),
        );
      if (completions.length === subjectIds.length) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(completions).toHaveLength(2);
    for (const completion of completions) {
      expect(completion.payload).toMatchObject({ recovery: true, disposition: 'enqueued' });
    }

    // First-execution proof: the pre-fix missing-queue throw would have written
    // an enqueue-failure metric (outcome='failure') before self-healing on
    // pg-boss retry / the nightly cron. There must be none.
    const failures = await db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.action, VERIFY_DISPATCH_COMPLETE_ACTION), eq(event.outcome, 'failure')));
    expect(failures).toHaveLength(0);

    // The intents were actually enqueued into the verifier queues (completed
    // job rows remain in the table until retention maintenance).
    const enqueued = await sqlClient.unsafe<Array<{ name: string; n: number }>>(
      `SELECT name, count(*)::int AS n FROM ${TEST_SCHEMA}.job WHERE name IN ('quiz_verify', 'source_verify') GROUP BY name`,
    );
    const byName = new Map(enqueued.map((row) => [row.name, row.n]));
    expect(byName.get('quiz_verify') ?? 0).toBe(1);
    expect(byName.get('source_verify') ?? 0).toBe(1);
  }, 45_000);
});
