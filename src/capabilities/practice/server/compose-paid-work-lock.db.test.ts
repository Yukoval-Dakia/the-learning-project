import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { resetDb } from '../../../../tests/helpers/db';
import { withinComposePaidWorkLock } from './compose-paid-work-lock';

const DATE = '2026-08-10';

beforeEach(async () => {
  await resetDb();
});

describe('Practice compose paid-work reserved adapter', () => {
  it('applies transaction config on the reserved session', async () => {
    // Given a reserved paid-work session with a configured top-level transaction.

    // When Drizzle applies SERIALIZABLE READ ONLY DEFERRABLE configuration.
    const settings = await withinComposePaidWorkLock(
      db,
      DATE,
      new Date(Date.now() + 5_000),
      (lockedDb) =>
        lockedDb.transaction(
          async (tx) => {
            const [row] = await tx.execute(sql<{
              isolation_level: string;
              read_only: string;
              deferrable: string;
            }>`
              SELECT
                current_setting('transaction_isolation') AS isolation_level,
                current_setting('transaction_read_only') AS read_only,
                current_setting('transaction_deferrable') AS deferrable
            `);
            return row;
          },
          { isolationLevel: 'serializable', accessMode: 'read only', deferrable: true },
        ),
    );

    // Then PostgreSQL observes all requested settings on that transaction.
    expect(settings).toEqual({
      isolation_level: 'serializable',
      read_only: 'on',
      deferrable: 'on',
    });
  });

  it('rolls back a nested transaction to a reserved-session savepoint', async () => {
    // Given an outer transaction on a paid-lock reserved connection.

    // When an inner transaction fails after writing through the same session.
    const values = await withinComposePaidWorkLock(
      db,
      DATE,
      new Date(Date.now() + 5_000),
      async (lockedDb) => {
        await lockedDb.execute(sql`CREATE TEMP TABLE compose_savepoint_probe (value integer)`);
        try {
          return await lockedDb.transaction(async (tx) => {
            await tx.execute(sql`INSERT INTO compose_savepoint_probe (value) VALUES (1)`);
            await expect(
              tx.transaction(async (nestedTx) => {
                await nestedTx.execute(sql`INSERT INTO compose_savepoint_probe (value) VALUES (2)`);
                throw new Error('rollback nested compose probe');
              }),
            ).rejects.toThrow('rollback nested compose probe');
            const rows = await tx.execute(sql<{ value: number }>`
              SELECT value FROM compose_savepoint_probe ORDER BY value
            `);
            return rows.map((row) => row.value);
          });
        } finally {
          await lockedDb.execute(sql`DROP TABLE IF EXISTS compose_savepoint_probe`);
        }
      },
    );

    // Then only the outer write survives and the outer transaction still commits.
    expect(values).toEqual([1]);
  });
});
