import { sql } from 'drizzle-orm';
import { type DrizzleTransactionLike, fromDrizzle } from 'pg-boss';

type ProjectDrizzleTx = {
  execute(query: unknown): Promise<unknown>;
};

function hasRowsResult(value: unknown): value is { rows: unknown[] } {
  return (
    typeof value === 'object' && value !== null && Array.isArray((value as { rows?: unknown }).rows)
  );
}

/** Adapt this repo's postgres-js Drizzle transaction to pg-boss's transactional send API. */
export function fromPgBossDrizzleTx(tx: ProjectDrizzleTx) {
  const txWithRows: DrizzleTransactionLike = {
    async execute(query) {
      const result = await tx.execute(query);
      if (Array.isArray(result)) return { rows: result };
      if (hasRowsResult(result)) return result;
      throw new Error('pg-boss Drizzle tx adapter received an unsupported execute() result');
    },
  };
  return fromDrizzle(txWithRows, sql);
}
