// YUK-697 (PR #939 round-2 #1) — reconcile must propagate the math source_policy seed
// bump (jyeooSupply + www.jyeoo.com whitelist) to ALREADY-DEPLOYED instances. A hydrated
// instance carries the trait payload in subject_trait; without a seed_version bump,
// reconcileBuiltinTraits hard-skips the row and jyeooSupply never reaches it (so
// JYEOO_FETCH_ENABLED=1 would still fall back to sourcing_web). This proves the bump makes
// reconcile upgrade an old-version row.

import { subject_trait } from '@/db/schema';
import { seedTraitId } from '@/subjects/builtin-trait-seeds';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { reconcileBuiltinTraits } from './reconcile-builtin-traits';

const db = testDb();

describe('reconcileBuiltinTraits — YUK-697 math source_policy jyeooSupply propagation', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('upgrades an already-deployed (v1.0.0, no jyeooSupply) math source_policy row', async () => {
    const traitId = seedTraitId('math', 'source_policy');

    // Fresh reconcile inserts the row at the current seed version (1.1.0, with jyeooSupply).
    await reconcileBuiltinTraits(db);
    const [fresh] = await db.select().from(subject_trait).where(eq(subject_trait.id, traitId));
    expect((fresh?.payload as { jyeooSupply?: unknown }).jyeooSupply).toEqual({ subject: 'math2' });

    // Simulate a pre-YUK-697 deployed instance: an OLD-version row WITHOUT jyeooSupply (the
    // shape a hydrated instance would carry before this PR).
    const oldPayload = Object.fromEntries(
      Object.entries(fresh?.payload as Record<string, unknown>).filter(
        ([k]) => k !== 'jyeooSupply',
      ),
    );
    await db
      .update(subject_trait)
      .set({ seed_version: '1.0.0', payload: oldPayload })
      .where(eq(subject_trait.id, traitId));

    // Re-running reconcile must detect the seed_version mismatch and UPGRADE (not skip).
    const report = await reconcileBuiltinTraits(db);
    expect(report.upgradedTraits).toBeGreaterThanOrEqual(1);

    const [after] = await db.select().from(subject_trait).where(eq(subject_trait.id, traitId));
    expect(after?.seed_version).toBe('1.1.0');
    // This payload is exactly what hydrateSubjectRegistryFromDb reads into the math profile,
    // so the upgraded row means a hydrated instance now exposes jyeooSupply.
    expect((after?.payload as { jyeooSupply?: unknown }).jyeooSupply).toEqual({ subject: 'math2' });
  });

  it('is a hard no-op on a second run at the current seed version (idempotent)', async () => {
    await reconcileBuiltinTraits(db);
    const report = await reconcileBuiltinTraits(db);
    expect(report.upgradedTraits).toBe(0);
    expect(report.insertedTraits).toBe(0);
  });
});
