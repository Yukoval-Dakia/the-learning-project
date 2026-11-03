// Subject control writes: rename, retire, restore, reset and a stateless validate.
// Parsing and outcomes live in the shared request module; a successful write rehydrates
// the registry.

import { db } from '@/db/client';
import {
  requestRenameAdminSubject,
  requestResetAdminSubject,
  requestRestoreAdminSubject,
  requestRetireAdminSubject,
  requestValidateAdminSubject,
} from '../server/admin-control-request';
import { adminControlRoute } from './subjects-write-http';

export const PATCH = adminControlRoute(db, requestRenameAdminSubject);
export const RETIRE = adminControlRoute(db, requestRetireAdminSubject);
export const RESTORE = adminControlRoute(db, requestRestoreAdminSubject);
export const RESET = adminControlRoute(db, requestResetAdminSubject);
// Empty body is valid for a pure check, but malformed JSON is still 400.
export const VALIDATE = adminControlRoute(db, requestValidateAdminSubject, 'optional');
