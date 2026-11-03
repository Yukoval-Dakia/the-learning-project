// Subject-scoped trait writes: edit (copy-on-write), explicit fork, and rebind.
// Shared operations own hydration; the request module owns parsing and outcomes.

import { db } from '@/db/client';
import {
  requestEditSubjectTrait,
  requestForkSubjectTrait,
  requestRebindSubjectTrait,
} from '../server/admin-control-request';
import { adminControlRoute } from './subjects-write-http';

export const PUT = adminControlRoute(db, requestEditSubjectTrait);
export const FORK = adminControlRoute(db, requestForkSubjectTrait);
export const BINDING = adminControlRoute(db, requestRebindSubjectTrait);
