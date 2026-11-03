// Trait write endpoints: shared edit (affects every binding), rollback-forward, and
// reset to seed. Shared operations own hydration; the request module owns parsing and outcomes.

import { db } from '@/db/client';
import {
  requestEditSharedTrait,
  requestResetTraitToSeed,
  requestRollbackTrait,
} from '../server/admin-control-request';
import { adminControlRoute } from './subjects-write-http';

export const PUT = adminControlRoute(db, requestEditSharedTrait);
export const ROLLBACK = adminControlRoute(db, requestRollbackTrait);
export const RESET_TO_SEED = adminControlRoute(db, requestResetTraitToSeed);
