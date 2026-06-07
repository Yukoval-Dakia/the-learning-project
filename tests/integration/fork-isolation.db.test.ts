// YUK-252 — fork-isolation self-proof.
//
// Asserts that this worker is talking to its OWN cloned database
// (derived from VITEST_POOL_ID), not the shared template `test` db. This is the
// load-bearing invariant behind running the db partition with fork workers:
// if any fork silently fell back to the template, tests across forks would race
// on the same rows. We prove the wiring (global-setup clone → setup.db-fork env
// rewrite → testDb lazy pool) actually lands each fork on a distinct database.
//
// `*.db.test.ts` under tests/** lands in the db partition (allTestInclude minus
// fastTestInclude); it imports the testDb helper, so it must NOT be a unit test.

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbForkDatabaseName } from '../db-fork-constants';
import { resetDb, testDb } from '../helpers/db';

describe('db fork isolation (YUK-252)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('connects to this fork’s cloned database, not the shared template', async () => {
    const poolId = process.env.VITEST_POOL_ID;
    if (!poolId) {
      throw new Error('VITEST_POOL_ID must be set under the forks pool');
    }

    const db = testDb();
    const rows = (await db.execute<{ current_database: string }>(
      sql`SELECT current_database() AS current_database`,
    )) as unknown as Array<{ current_database: string }>;
    const current = rows[0]?.current_database;

    expect(current).toBe(dbForkDatabaseName(poolId));
    // Belt-and-suspenders: never the un-cloned template, which would mean the
    // setupFile env rewrite did not take effect for this worker.
    expect(current).not.toBe('test');
  });
});
