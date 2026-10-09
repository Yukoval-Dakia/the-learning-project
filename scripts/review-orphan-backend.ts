import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { loadEnv } from '../server/env';

// Client-only control. No SDK launch, recovery, replay, queue deletion or phase default change.
const action = z
  .enum([
    'status',
    'begin-dbos',
    'finish-dbos',
    'begin-rollback',
    'finish-rollback',
    'quiesce',
    'inspect',
    'retire',
  ])
  .parse(process.argv[2]);
loadEnv();
const { db } = await import('@/db/client');
const family = await import('@/server/durable/review-orphan-family');
const url = z.url().parse(process.env.DATABASE_URL);
const boss = new PgBoss({
  connectionString: url,
  max: 1,
  schedule: false,
  supervise: false,
  migrate: false,
});
boss.on('error', (error) => console.error('[review-orphan-backend]', error));
const client = await DBOSClient.create({
  systemDatabaseUrl: url,
  systemDatabaseSchemaName: 'tlp_dbos',
  systemDatabasePoolSize: 1,
  applicationName: 'tlp-housekeeping',
});
try {
  await boss.start();
  if (action === 'quiesce')
    await family.attestReviewOrphanQuiescence(db, z.string().trim().min(1).parse(process.argv[3]));
  else if (action === 'inspect')
    console.log(
      JSON.stringify(
        await family.inspectReviewOrphanOutcome(db, {
          tickId: z.string().min(1).parse(process.argv[3]),
          sessionId: z.string().min(1).parse(process.argv[4]),
        }),
      ),
    );
  else if (action === 'retire')
    await family.retireFailedReviewOrphan(db, {
      backend: z.enum(['pg-boss', 'dbos']).parse(process.argv[3]),
      taskId: z.string().min(1).parse(process.argv[4]),
      reason: z.string().trim().min(1).parse(process.argv[5]),
      ...(process.argv[6] ? { sessionId: process.argv[6] } : {}),
    });
  else if (action !== 'status') {
    const phases = {
      'begin-dbos': 'draining-pg-boss',
      'finish-dbos': 'dbos',
      'begin-rollback': 'draining-dbos',
      'finish-rollback': 'pg-boss',
    } as const;
    await family.changeReviewOrphanPhase(db, boss, phases[action], client);
  }
  console.log(
    JSON.stringify(
      {
        phase: await family.readReviewOrphanPhase(db),
        pgBossObligations: await family.reviewOrphanObligations(db, 'pg-boss'),
        dbosObligations: await family.reviewOrphanObligations(db, 'dbos'),
        rollbackNotBefore: await family.reviewOrphanRollbackHorizon(db),
        quiescenceRequired:
          'Verify all old consumers and suspended/in-flight forwarders stopped. Record evidence with quiesce at this drain barrier.',
      },
      null,
      2,
    ),
  );
} finally {
  await client.destroy();
  await boss.stop();
  await db.$client.end();
}
