import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { CreatePlacementHeldReleaseBodySchema } from '../../api/placement-contracts';
import { runPlacementAdvance } from '../placement-advance';

// Complete held-release operation shared by HTTP and the authenticated host binding.
// Advance commits before the independent starter-supply snapshot, as in the original route.
export async function releaseHeldPlacement(db: Db, sessionId: string, raw: unknown) {
  const parsed = CreatePlacementHeldReleaseBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      400,
    );
  }

  const { selection, release } = await runPlacementAdvance(db, sessionId, {
    releaseIssuanceId: parsed.data.issuance_id,
  });

  return {
    released: true,
    replayed: release?.replayed ?? false,
    selection,
  };
}
