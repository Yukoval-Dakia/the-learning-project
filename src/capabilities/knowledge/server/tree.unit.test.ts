import { describe, expect, it, vi } from 'vitest';
import { LOAD_TREE_SNAPSHOT_LIMIT, warnIfTreeSnapshotTruncated } from './tree';

// YUK-236 [STB-2] — pure (no-DB) coverage for the loadTreeSnapshot OOM guard.
// Only the truncation-warn decision is exercised here; the `.limit(5000)` query
// bound + parent-chain semantics are covered by the DB-partition tree.test.ts.
// Imports only ./tree (which value-imports @/db/schema — pure table objects — and
// drizzle-orm; @/db/client is type-only), so no live Postgres is touched.
describe('warnIfTreeSnapshotTruncated', () => {
  it('does not warn below the cap', () => {
    const warn = vi.fn();
    expect(warnIfTreeSnapshotTruncated(LOAD_TREE_SNAPSHOT_LIMIT - 1, warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once the row count reaches the cap (truncation suspected)', () => {
    const warn = vi.fn();
    expect(warnIfTreeSnapshotTruncated(LOAD_TREE_SNAPSHOT_LIMIT, warn)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0];
    expect(message).toContain('loadTreeSnapshot hit row cap');
    expect(context).toMatchObject({
      event: 'tree_snapshot_truncated',
      limit: LOAD_TREE_SNAPSHOT_LIMIT,
      row_count: LOAD_TREE_SNAPSHOT_LIMIT,
    });
  });

  it('warns when the row count exceeds the cap (defensive; query caps at limit)', () => {
    const warn = vi.fn();
    expect(warnIfTreeSnapshotTruncated(LOAD_TREE_SNAPSHOT_LIMIT + 100, warn)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
