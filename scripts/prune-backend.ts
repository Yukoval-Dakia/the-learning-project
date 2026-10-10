import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { loadEnv } from '../server/env';

// This command manages the single admitted family. It never registers workflows,
// runs a handler, deletes queue rows, or retries a task. Workers own execution.
const action = z
  .enum(['status', 'begin-dbos', 'finish-dbos', 'begin-rollback', 'finish-rollback', 'retire'])
  .parse(process.argv[2]);
loadEnv();
const { db } = await import('@/db/client');
const { readPrunePhase, pruneObligations, changePrunePhase, retireFailedPrune, PRUNE_DBOS_SCHEMA } =
  await import('@/server/durable/prune-family');
const url = z.url().parse(process.env.DATABASE_URL);
const boss = new PgBoss({
  connectionString: url,
  max: 1,
  schedule: false,
  supervise: false,
  migrate: false,
});
boss.on('error', (error) => {
  console.error('[prune-backend]', error);
});
const client = await DBOSClient.create({
  systemDatabaseUrl: url,
  systemDatabaseSchemaName: PRUNE_DBOS_SCHEMA,
  systemDatabasePoolSize: 1,
  applicationName: 'tlp-housekeeping',
});
try {
  await boss.start();
  if (action === 'retire')
    await retireFailedPrune(
      db,
      z.enum(['pg-boss', 'dbos']).parse(process.argv[3]),
      z.string().min(1).parse(process.argv[4]),
      z.string().min(1).parse(process.argv[5]),
    );
  else if (action !== 'status') {
    const phases = {
      'begin-dbos': 'draining-pg-boss',
      'finish-dbos': 'dbos',
      'begin-rollback': 'draining-dbos',
      'finish-rollback': 'pg-boss',
    } as const;
    await changePrunePhase(db, boss, phases[action], client);
  }
  console.log(
    JSON.stringify(
      {
        phase: await readPrunePhase(db),
        pgBossObligations: await pruneObligations(db, 'pg-boss'),
        dbosObligations: await pruneObligations(db, 'dbos'),
      },
      null,
      2,
    ),
  );
} finally {
  await client.destroy();
  await boss.stop();
  // db/client's application pool also belongs to this short-lived command.
  await db.$client.end();
}
