import { readFile, writeFile } from 'node:fs/promises';
import {
  freezePhotoJudgeExamInput,
  photoJudgeExamConfiguration,
  runPhotoJudgeExam,
  verifyPhotoJudgeExam,
} from '@/capabilities/practice/public';

// No default DB target, environment loading or route override. The operator owns the environment.
const file = process.argv[2];
if (!file)
  throw new Error(
    'Usage: pnpm tsx scripts/photo-judge-exam.ts request.json [--inspect|--freeze|--verify]',
  );
const raw = JSON.parse(await readFile(file, 'utf8'));
if (raw.dry_run !== true) throw new Error('Photo exam requires dry_run=true');
const target = new URL(process.env.DATABASE_URL ?? '');
console.info('photo-exam-database', {
  host: target.hostname,
  port: target.port,
  database: target.pathname.slice(1),
});
const { db } = await import('@/db/client');
try {
  const { hydrateConfigFromDb } = await import('@/core/config/server/hydrate');
  const { hydrateModelCatalog } = await import('@/server/ai/model-catalog');
  const { hydrateCustomProviders } = await import('@/core/config/server/custom-providers-hydrate');
  const config = await hydrateConfigFromDb(db);
  if (
    !['loaded', 'unchanged'].includes(config.outcome) ||
    config.skipped.some(
      (row) => row.key.startsWith(`task.${raw.identity.task_kind}.`) || row.key.startsWith('lane.'),
    )
  )
    throw new Error('Photo exam config hydration failed or rejected routing rows');
  await hydrateCustomProviders(db);
  const catalog = await hydrateModelCatalog(db);
  console.info('photo-exam-route', {
    ...photoJudgeExamConfiguration(raw.identity.task_kind),
    config_epoch: config.epoch,
    catalog: { origin: catalog.origin, version: catalog.version },
  });
  if (process.argv.includes('--inspect')) {
    console.info('Inspection only; no model invocation');
  } else if (process.argv.includes('--freeze')) {
    await writeFile(
      `${file}.frozen.json`,
      JSON.stringify(freezePhotoJudgeExamInput(raw), null, 2),
      { flag: 'wx' },
    );
    console.info('Frozen request written; no model invocation');
  } else {
    console.info(
      JSON.stringify(
        process.argv.includes('--verify')
          ? await verifyPhotoJudgeExam(db, raw.run_id, raw.identity.task_kind)
          : await runPhotoJudgeExam(db, raw),
      ),
    );
  }
} finally {
  await db.$client.end({ timeout: 5 });
}
