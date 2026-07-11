// YUK-601 PR7 (v3.2 §7) — 夜间装配漂移审计 cron（--strict 语义：invalid > 0 时
// throw → job 显示 failed，admin jobs 观测面可见；fast 档无 DLQ，掉一拍下个
// cron 重跑）。与 `pnpm audit:profile --db --strict` 同一审计路径
// （auditProfilesFromDb），cron 只是它的无人值守形态。

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
