import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import {
  attestSessionOrphanQuiescence,
  changeSessionOrphanPhase,
  parseSessionOrphanCommand,
  retireFailedSessionOrphan,
  sessionOrphanObligations,
  sessionOrphanRollbackHorizon,
} from '@/server/durable/session-orphan-backend';
import {
  inspectSessionOrphanOutcome,
  readSessionOrphanPhase,
} from '@/server/durable/session-orphan-family';
import { loadEnv } from '../server/env';

// Parse before environment or client creation. Every action requires an exact family.
const command = parseSessionOrphanCommand(process.argv.slice(2));
loadEnv();
const { db } = await import('@/db/client');
const url = z.url().parse(process.env.DATABASE_URL);
const boss = new PgBoss({
  connectionString: url,
  max: 1,
  schedule: false,
  supervise: false,
  migrate: false,
});
boss.on('error', (error) => console.error('[session-orphan-backend]', error));
const client = await DBOSClient.create({
  systemDatabaseUrl: url,
  systemDatabaseSchemaName: 'tlp_dbos',
  systemDatabasePoolSize: 1,
  applicationName: 'tlp-housekeeping',
});
try {
  await boss.start();
  const { family, action } = command;
  if (action === 'quiesce')
    await attestSessionOrphanQuiescence(db, { family, reason: command.reason });
  else if (action === 'inspect')
    console.log(
      JSON.stringify(
        await inspectSessionOrphanOutcome(db, {
          family,
          tickId: command.tickId,
          sessionId: command.sessionId,
        }),
      ),
    );
  else if (action === 'retire') await retireFailedSessionOrphan(db, command.disposition);
  else if (action !== 'status') {
    const phases = {
      'begin-dbos': 'draining-pg-boss',
      'finish-dbos': 'dbos',
      'begin-rollback': 'draining-dbos',
      'finish-rollback': 'pg-boss',
    } as const;
    await changeSessionOrphanPhase(db, boss, { family, target: phases[action] }, client);
  }
  const [control] = await db.execute(
    (await import('drizzle-orm'))
      .sql`select phase_changed_at::text as drain_barrier, legacy_not_before::text from session_orphan_control where family = ${family}`,
  );
  console.log(
    JSON.stringify(
      {
        family,
        phase: await readSessionOrphanPhase(db, family),
        ...control,
        pgBossObligations: await sessionOrphanObligations(db, { family, backend: 'pg-boss' }),
        dbosObligations: await sessionOrphanObligations(db, { family, backend: 'dbos' }),
        rollbackNotBefore: await sessionOrphanRollbackHorizon(db, family),
        quiescenceRequired:
          'Observe every old handler, scheduler, suspended executor and forwarder exit before attesting this family drain barrier.',
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await client.destroy();
  } finally {
    try {
      await boss.stop();
    } finally {
      await db.$client.end();
    }
  }
}
