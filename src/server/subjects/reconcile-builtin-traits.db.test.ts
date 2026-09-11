// YUK-986 (Supply-Agent/1) — reconcile must propagate the math source_policy seed bump
// that REMOVES jyeooSupply (1.1.0 → 1.2.0) to already-deployed instances. The YUK-697
// queue-shaped jyeoo line was retired (producer economics incompatible with per-target
// dispatch); if the bump didn't propagate, a hydrated instance would keep the stale
// jyeooSupply declaration — a lying config pointing at dead machinery. This proves the
// upgrade strips the field. (Shape mirrors the YUK-697 PR #939 round-2 #1 test that
// originally proved the additive direction.)

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { subject_trait } from '@/db/schema';
import { seedTraitId } from '@/subjects/builtin-trait-seeds';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { reconcileBuiltinTraits } from './reconcile-builtin-traits';

const db = testDb();

describe('reconcileBuiltinTraits — YUK-986 math source_policy jyeooSupply removal propagation', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('upgrades an already-deployed (v1.1.0, with jyeooSupply) math source_policy row', async () => {
    const traitId = seedTraitId('math', 'source_policy');

    // Fresh reconcile inserts the row at the current seed version (1.2.0, NO jyeooSupply).
    await reconcileBuiltinTraits(db);
    const [fresh] = await db.select().from(subject_trait).where(eq(subject_trait.id, traitId));
    expect(fresh?.seed_version).toBe('1.2.0');
    expect((fresh?.payload as { jyeooSupply?: unknown }).jyeooSupply).toBeUndefined();
    // The www.jyeoo.com whitelist entry stays (still the commit tool's whitelist for math).
    expect((fresh?.payload as { sourceWhitelist?: string[] }).sourceWhitelist).toContain(
      'www.jyeoo.com',
    );

    // Simulate a YUK-697-era deployed instance: an OLD-version row WITH jyeooSupply (the
    // shape a hydrated instance carries today).
    const oldPayload = {
      ...(fresh?.payload as Record<string, unknown>),
      jyeooSupply: { subject: 'math2' },
    };
    await db
      .update(subject_trait)
      .set({ seed_version: '1.1.0', payload: oldPayload })
      .where(eq(subject_trait.id, traitId));

    // Re-running reconcile must detect the seed_version mismatch and UPGRADE (not skip).
    const report = await reconcileBuiltinTraits(db);
    expect(report.upgradedTraits).toBeGreaterThanOrEqual(1);

    const [after] = await db.select().from(subject_trait).where(eq(subject_trait.id, traitId));
    expect(after?.seed_version).toBe('1.2.0');
    // This payload is exactly what hydrateSubjectRegistryFromDb reads into the math profile,
    // so the upgraded row means a hydrated instance no longer exposes jyeooSupply.
    expect((after?.payload as { jyeooSupply?: unknown }).jyeooSupply).toBeUndefined();
  });

  it('is a hard no-op on a second run at the current seed version (idempotent)', async () => {
    await reconcileBuiltinTraits(db);
    const report = await reconcileBuiltinTraits(db);
    expect(report.upgradedTraits).toBe(0);
    expect(report.insertedTraits).toBe(0);
  });
});
