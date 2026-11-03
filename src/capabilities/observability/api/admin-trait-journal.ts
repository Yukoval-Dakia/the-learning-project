// Append-only trait history for the rollback UI, newest first. Payloads are not
// included; this is a revision list.

import { db } from '@/db/client';
import { requestAdminTraitJournal } from '../server/admin-control-request';
import { adminControlRoute } from './subjects-write-http';

export const GET = adminControlRoute(db, requestAdminTraitJournal);
