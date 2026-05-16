import { createId } from '@paralleldrive/cuid2';

export const newId = createId;

// Deterministic id keyed by a stable source id + namespace prefix. Used by
// Phase 1c.1 Step 3 migration to map legacy rows → event/material_fsrs_state
// rows with idempotent IDs (re-running migration is a no-op via PK conflict).
// Example: deterministicId('evt_mistake', mistake.id) → 'evt_mistake_<cuid2>'.
export const deterministicId = (prefix: string, sourceId: string): string =>
  `${prefix}_${sourceId}`;
