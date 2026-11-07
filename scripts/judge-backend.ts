import { z } from 'zod';
import { loadEnv } from '../server/env';
import { guardDatabaseUrl } from './local-db-env';

// Client-only control. No SDK launch, recovery, replay, queue deletion or phase default change.
const [rawAction, ...rest] = z.tuple([z.string()]).rest(z.string()).parse(process.argv.slice(2));
const action = z
  .enum([
    'status',
    'begin-dbos',
    'finish-dbos',
    'begin-rollback',
    'finish-rollback',
    'dispose',
    'map-pending',
  ])
  .parse(rawAction);
const csvList = (raw: string) =>
  z
    .array(z.string().trim().min(1))
    .min(1)
    .parse(
      raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    );
loadEnv();
guardDatabaseUrl('judge-backend');
const { db } = await import('@/db/client');
const engine = await import('@/capabilities/practice/grading/public');
const family = await import('@/server/durable/judge-family');
const parsed = new URL(z.url().parse(process.env.DATABASE_URL));
const target = { host: parsed.hostname, port: parsed.port, database: parsed.pathname.slice(1) };
/** Fresh census of the engine the current phase is draining from. */
async function sourceInventory() {
  const control = await family.readJudgeFamilyControl(db);
  return control.phase === 'dbos' || control.phase === 'draining-dbos'
    ? await engine.inspectDbosJudgeInventory()
    : await family.inspectLegacyJudgeInventory(db);
}
async function status() {
  const pgBossObligations = await family.inspectLegacyJudgeObligations(db).then(
    (items) => ({ items }),
    (error: unknown) => ({ error: String(error) }),
  );
  const dbosInventory = await engine.inspectDbosJudgeInventory().then(
    (inventory) => ({
      digest: inventory.digest,
      observedAt: inventory.observed_at,
      items: inventory.items,
    }),
    (error: unknown) => ({ error: String(error) }),
  );
  console.log(
    JSON.stringify(
      {
        target,
        control: await family.readJudgeFamilyControl(db),
        pgBossObligations,
        dbosInventory,
      },
      null,
      2,
    ),
  );
}
try {
  if (action === 'dispose') {
    const [taskId, backend, reason, actorRef, refs] = z
      .tuple([
        z.string().min(1),
        z.enum(['pg-boss', 'dbos']),
        z.enum(['historical_unknown', 'explicit_disposal', 'provider_unknown']),
        z.string().trim().min(1),
        z.string().min(1),
      ])
      .parse(rest);
    const items =
      backend === 'pg-boss'
        ? await family.inspectLegacyJudgeObligations(db)
        : (await engine.inspectDbosJudgeInventory()).items;
    const obligation = items.find((item) => item.task_id === taskId);
    if (!obligation) throw new Error(`No ${backend} judge obligation ${taskId}`);
    const control = await family.readJudgeFamilyControl(db);
    await family.disposeLegacyJudgeObligation(db, {
      obligation,
      backend,
      reason,
      actorRef,
      evidenceRefs: csvList(refs),
      owner: { incarnation: control.incarnation, epoch: control.epoch, backend },
    });
  } else if (action === 'map-pending') {
    const [runId, rawRecovery, refs] = z
      .tuple([z.string().min(1), z.string().min(1), z.string().min(1)])
      .parse(rest);
    const control = await family.readJudgeFamilyControl(db);
    const source = await family.inspectJudgePendingImport(db, runId);
    await family.mapJudgePendingOwnership(db, {
      runId,
      target: {
        incarnation: control.incarnation,
        epoch: control.epoch + 1,
        backend: control.phase === 'draining-pg-boss' ? 'dbos' : 'pg-boss',
      },
      recoveryHistory:
        rawRecovery === 'unknown' ? 'unknown' : rawRecovery === 'none' ? [] : csvList(rawRecovery),
      sourceDigest: source.digest,
      evidenceRefs: csvList(refs),
      engineInventory: await sourceInventory(),
    });
  } else if (action !== 'status') {
    const [actorRef, refs] = z.tuple([z.string().trim().min(1), z.string().min(1)]).parse(rest);
    const phases = {
      'begin-dbos': 'draining-pg-boss',
      'finish-dbos': 'dbos',
      'begin-rollback': 'draining-dbos',
      'finish-rollback': 'pg-boss',
    } as const;
    const control = await family.readJudgeFamilyControl(db);
    const inventory = await sourceInventory();
    await family.transitionJudgeFamily(db, {
      expectedEpoch: control.epoch,
      nextPhase: phases[action],
      actorRef,
      evidenceRefs: csvList(refs),
      evidenceDigest: inventory.digest,
      engineInventory: inventory,
    });
  } else {
    z.tuple([]).parse(rest);
  }
  await status();
} finally {
  await db.$client.end();
}
