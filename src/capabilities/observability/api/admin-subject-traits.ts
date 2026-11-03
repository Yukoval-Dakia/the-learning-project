// Six trait bindings per subject. Live revision and effective revision are separate,
// so a degraded trait still shows what is actually in use.

import { db } from '@/db/client';
import { requestAdminSubjectTraits } from '../server/admin-control-request';
import { adminControlRoute } from './subjects-write-http';

export const GET = adminControlRoute(db, requestAdminSubjectTraits);
