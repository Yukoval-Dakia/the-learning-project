import {
  MEMORY_INGEST_RECOVERY_HELP,
  parseMemoryIngestRecoveryArgs,
} from './lib/memory-ingest-recovery-cli';

async function main(): Promise<void> {
  const command = parseMemoryIngestRecoveryArgs(process.argv.slice(2));
  if (command.kind === 'help') {
    console.log(MEMORY_INGEST_RECOVERY_HELP);
    return;
  }
  const { loadEnv } = await import('../server/env');
  loadEnv();
  // Standalone operator entry: load only the memory-owned recovery surface after parsing.
  const { db } = await import('../src/db/client');
  try {
    const { authorizeMemoryIngestReplay, listStalledMemoryIngests, memoryIngestReplayGrantId } =
      await import('../src/capabilities/agency/server/memory/memory-ingest-recovery-store');
    if (command.kind === 'list') {
      console.log(
        JSON.stringify(await listStalledMemoryIngests(db, command.afterId, command.limit), null, 2),
      );
      return;
    }
    const { hydrateConfigFromDb } = await import('../src/core/config/server/hydrate');
    await hydrateConfigFromDb(db);
    const grant = await authorizeMemoryIngestReplay(db, command.request);
    const { createBoss, getStartedBoss } = await import('../src/server/boss/client');
    const boss = createBoss();
    try {
      await getStartedBoss();
      const { buildMemoryEventIngestHandler } = await import(
        '../src/capabilities/agency/server/memory/triggers'
      );
      await buildMemoryEventIngestHandler(db, boss, { replayGrant: grant })([
        { data: { event_id: command.request.sourceEventId } },
      ]);
      const { readIngestCompleted } = await import(
        '../src/capabilities/agency/server/memory/memory-reconcile-handoff-store'
      );
      const completed = await readIngestCompleted(db, command.request.sourceEventId);
      if (!completed) throw new Error('memory ingest recovery did not seal completion');
      console.log(
        JSON.stringify({
          sourceEventId: command.request.sourceEventId,
          grantId: memoryIngestReplayGrantId(grant),
          status: 'completed',
          resolution: completed.resolution,
          memoryCount: completed.memory_count,
        }),
      );
    } finally {
      await boss.stop();
    }
  } finally {
    await db.$client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'memory ingest recovery failed');
  process.exitCode = 1;
});
