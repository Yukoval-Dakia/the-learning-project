// YUK-569 — pure (no-DB) unit for the isPoolVisible JS twin (src/db/predicates.ts).
//
// UNIT partition: imports ONLY the connection-free predicate module RELATIVELY (no drizzle-orm,
// no @/db alias, no Postgres), so it stays in the fast no-DB lane (fastTestInclude +
// DB_TAINTED_DIR_EXCEPTIONS entry, mirroring src/db/vector.test.ts). The Drizzle compiled-SQL
// shape assertion — which needs drizzle-orm — is the sibling predicates.db.test.ts (db partition).

import { describe, expect, it } from 'vitest';
import { isPoolVisible } from './predicates';

// §5.1 truth table: a row is POOL-VISIBLE (红线-4, NULL≡active) unless it is literally 'draft'.
const CLASSES: Array<{ label: string; value: string | null; visible: boolean }> = [
  { label: 'NULL', value: null, visible: true },
  { label: "'draft'", value: 'draft', visible: false },
  { label: "'active'", value: 'active', visible: true },
  { label: "'final' (legacy)", value: 'final', visible: true },
  { label: 'arbitrary string', value: 'whatever', visible: true },
];

describe('isPoolVisible — §5.1 truth table', () => {
  for (const c of CLASSES) {
    it(`${c.label} → ${c.visible ? 'visible' : 'excluded'}`, () => {
      expect(isPoolVisible({ draft_status: c.value })).toBe(c.visible);
    });
  }

  it('defensive undefined maps to visible (matches SQL NULL; cannot arise from a DB read)', () => {
    expect(isPoolVisible({ draft_status: undefined as unknown as string | null })).toBe(true);
  });
});
