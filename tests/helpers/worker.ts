import type { PgBoss } from 'pg-boss';

import type { Db } from '@/db/client';
import { _resetBossForTests, createBoss } from '@/server/boss/client';
import { registerHandlers } from '@/server/boss/handlers';
import { startListenLoop, stopListenLoop } from '@/server/events/listen_loop';

/**
 * Start an in-process pg-boss worker + listen loop for E2E tests.
 *
 * Returns a teardown function. Tests should call `await teardown()` in afterAll
 * to release the connection pool + LISTEN socket; vitest's singleFork pool
 * means leaving them open can hang tests across files.
 */
export async function startTestWorker(db: Db): Promise<{
  boss: PgBoss;
  teardown: () => Promise<void>;
}> {
  _resetBossForTests();
  const boss = createBoss();
  await boss.start();
  await registerHandlers(boss, db);
  await startListenLoop();
  // Allow LISTEN to register
  await new Promise((r) => setTimeout(r, 100));
  return {
    boss,
    teardown: async () => {
      await stopListenLoop();
      await boss.stop({ graceful: false, timeout: 1_000 });
      _resetBossForTests();
    },
  };
}
