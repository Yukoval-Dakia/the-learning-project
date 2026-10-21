// Nightly profile assembly audit with strict semantics: any invalid profile throws,
// so the job shows as failed. Same audit path as the CLI's strict DB mode; the cron
// is just its unattended form.

import type { Db } from '@/db/client';
import {
  auditProfilesFromDb,
  formatDbProfileAuditReport,
} from '@/server/subjects/audit-profile-db';

export function buildSubjectProfileAuditNightlyHandler(db: Db) {
  return async (): Promise<void> => {
    const result = await auditProfilesFromDb(db);
    const report = formatDbProfileAuditReport(result);
    if (result.valid) {
      console.log(`[subject_profile_audit_nightly] ${result.total} subjects OK`);
      if (result.warnings > 0) console.log(report);
      return;
    }
    console.error(`[subject_profile_audit_nightly] STRICT FAIL\n${report}`);
    throw new Error(
      `subject profile DB-assembly audit failed: ${result.invalid}/${result.total} invalid`,
    );
  };
}
