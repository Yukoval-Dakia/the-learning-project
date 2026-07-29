import { knowledge } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginTestTransaction, resetDb, rollbackTestTransaction, testDb } from './db';

describe('DB test transaction isolation', () => {
  beforeEach(resetDb);
  afterEach(rollbackTestTransaction);

  it('rolls back writes made through testDb()', async () => {
    await beginTestTransaction();
    await testDb().insert(knowledge).values({
      id: 'tx_rollback',
      name: 'transaction-local row',
      created_at: new Date(),
      updated_at: new Date(),
    });

    expect(
      await testDb().select().from(knowledge).where(eq(knowledge.id, 'tx_rollback')),
    ).toHaveLength(1);

    await rollbackTestTransaction();

    expect(
      await testDb().select().from(knowledge).where(eq(knowledge.id, 'tx_rollback')),
    ).toHaveLength(0);
  });

  it('rejects nested transactions and full resets while active', async () => {
    await beginTestTransaction();

    await expect(beginTestTransaction()).rejects.toThrow('already active');
    await expect(resetDb()).rejects.toThrow('inside an active test transaction');
  });

  it('maps application transactions to savepoints inside the test transaction', async () => {
    await beginTestTransaction();
    const db = testDb();
    const now = new Date();

    await db.insert(knowledge).values({
      id: 'outer_row',
      name: 'outer row',
      created_at: now,
      updated_at: now,
    });

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(knowledge).values({
          id: 'rolled_back_savepoint',
          name: 'rolled-back savepoint row',
          created_at: now,
          updated_at: now,
        });
        throw new Error('rollback nested work');
      }),
    ).rejects.toThrow('rollback nested work');

    expect(await db.select().from(knowledge).where(eq(knowledge.id, 'outer_row'))).toHaveLength(1);
    expect(
      await db.select().from(knowledge).where(eq(knowledge.id, 'rolled_back_savepoint')),
    ).toHaveLength(0);
  });

  it('fails closed instead of weakening configured transaction semantics', async () => {
    await beginTestTransaction();

    await expect(
      testDb().transaction(async () => undefined, {
        isolationLevel: 'serializable',
      }),
    ).rejects.toThrow(/SET TRANSACTION|transaction/i);
  });

  it('releases the reserved connection for the next test', async () => {
    await beginTestTransaction();
    await rollbackTestTransaction();
    await beginTestTransaction();

    await expect(testDb().select().from(knowledge)).resolves.toBeDefined();
  });
});
