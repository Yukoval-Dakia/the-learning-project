/**
 * Backup reverse-lockstep guard (②d) — every pgTable in src/db/schema.ts must be
 * either backed up (FK_ORDER) or explicitly excluded (BACKUP_EXCLUDED_TABLES).
 *
 * buildColumnAllowlist() in archive.ts already enforces FK_ORDER → schema (every
 * backed-up table has a pgTable export). This is the OTHER direction: schema →
 * coverage. Adding a pgTable but forgetting to wire it into FK_ORDER made it
 * SILENTLY drop out of the wipe-then-restore backup — a data-loss hole no test
 * or lint previously caught. archive.ts now asserts coverage at module load; these
 * tests lock that contract in and prove the synthetic failure path.
 *
 * Lives in the DB partition (not because it touches Postgres — it doesn't — but
 * because it imports @/db/schema + drizzle-orm, which the partition audit treats
 * as DB-tainted; see scripts/audit-test-partition.ts). Mirrors the isTable /
 * getTableName reflection archive.ts uses at load.
 */
import * as schema from '@/db/schema';
import { BACKUP_EXCLUDED_TABLES, FK_ORDER } from '@/server/export/constants';
import { getTableName, isTable } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

function schemaTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (isTable(value)) names.push(getTableName(value));
  }
  return names;
}

describe('backup reverse-lockstep (②d) — every pgTable is backed up or excluded', () => {
  it('the current schema has ZERO backup orphans', () => {
    // pgViews (knowledge_mastery) are naturally excluded by isTable. This fails the
    // instant a new pgTable is added without wiring it into FK_ORDER or
    // BACKUP_EXCLUDED_TABLES — the exact silent backup hole ②d fixes.
    const covered = new Set<string>([...FK_ORDER, ...BACKUP_EXCLUDED_TABLES]);
    const orphans = schemaTableNames().filter((t) => !covered.has(t));
    expect(orphans).toEqual([]);
  });

  it('a synthetic orphan (table covered by neither set) would be detected', () => {
    // Simulate the failure mode: a freshly-added table absent from both sets.
    const covered = new Set<string>([...FK_ORDER, ...BACKUP_EXCLUDED_TABLES]);
    const withSynthetic = [...schemaTableNames(), 'brand_new_unwired_table'];
    const orphans = withSynthetic.filter((t) => !covered.has(t));
    expect(orphans).toEqual(['brand_new_unwired_table']);
  });

  it('archive.ts module loads without throwing (real reverse-lockstep guard passes)', async () => {
    // Importing the real module runs assertEveryTableIsBackedUpOrExcluded() at load.
    // If a future schema change introduced an orphan, this import would throw — the
    // load-time guard is the production enforcement; this proves it currently passes
    // against the live schema.
    await expect(import('./archive')).resolves.toBeDefined();
  });
});
