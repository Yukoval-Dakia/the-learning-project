import { createId } from '@paralleldrive/cuid2';

export const newId = createId;

// Deterministic id for idempotent migration mapping: same source id re-runs to the
// same PK, so a retry is a no-op.
export const deterministicId = (prefix: string, sourceId: string): string =>
  `${prefix}_${sourceId}`;
