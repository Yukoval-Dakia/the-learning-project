// Cross-subject trait catalog, used as the rebind selector. `kind` is required and
// must be one of the six trait kinds.

import { db } from '@/db/client';
import { requestAdminTraits } from '../server/admin-control-request';
import { adminControlRoute } from './subjects-write-http';

export const GET = adminControlRoute(db, requestAdminTraits);
