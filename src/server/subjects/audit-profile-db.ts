// 装配粒度漂移审计：逐个 DB subject 行（含 general 与 retired）读六绑定 →
// assemble → validateProfile。与编译期 audit:profile 互补：这里读 DB 活绑定，
// 抓共享 trait 被编辑后某科目装配变坏、deprecated judge 仍被引用等只在 DB 面
// 出现的漂移。report-only 由调用方裁；复用 validateSubject，使审计与写门预检
// 走同一条装配路径。

import { asc } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { subject } from '@/db/schema';
import { validateSubject } from '@/server/subjects/subject-control-write';
import { auditEvaluationSemantics } from '@/subjects/evaluation-semantics-audit';

export interface DbProfileAuditEntry {
  id: string;
  displayName: string;
  retired: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface DbProfileAuditResult {
  valid: boolean;
  total: number;
  invalid: number;
  warnings: number;
  entries: DbProfileAuditEntry[];
}

export async function auditProfilesFromDb(db: Db): Promise<DbProfileAuditResult> {
  const rows = await db
    .select({
      id: subject.id,
      displayName: subject.display_name,
      retiredAt: subject.retired_at,
    })
    .from(subject)
    .orderBy(asc(subject.created_at), asc(subject.id));

  const entries: DbProfileAuditEntry[] = [];
  for (const row of rows) {
    const result = await validateSubject(db, row.id);
    // Builtin fail-closed semantics: a legacy owner-edited cause_taxonomy row is
    // invalid here instead of silently inheriting cross-subject defaults.
    const semanticErrors =
      result?.profile !== undefined ? auditEvaluationSemantics(result.profile) : [];
    entries.push({
      id: row.id,
      displayName: row.displayName,
      retired: row.retiredAt !== null,
      valid: (result?.valid ?? false) && semanticErrors.length === 0,
      errors: [...(result?.errors ?? ['subject vanished mid-audit']), ...semanticErrors],
      warnings: result?.warnings ?? [],
    });
  }

  const invalid = entries.filter((e) => !e.valid).length;
  return {
    valid: invalid === 0,
    total: entries.length,
    invalid,
    warnings: entries.reduce((n, e) => n + e.warnings.length, 0),
    entries,
  };
}

export function formatDbProfileAuditReport(result: DbProfileAuditResult): string {
  const lines = [
    'SubjectProfile DB-assembly audit (YUK-601 PR7)',
    `subjects: ${result.total}`,
    `invalid: ${result.invalid}`,
    `warnings: ${result.warnings}`,
  ];
  for (const e of result.entries) {
    if (e.valid && e.warnings.length === 0) continue;
    lines.push('');
    lines.push(
      `[${e.id}] ${e.displayName}${e.retired ? ' (retired)' : ''} — ${e.valid ? 'valid' : 'INVALID'}`,
    );
    for (const err of e.errors) lines.push(`  error: ${err}`);
    for (const w of e.warnings) lines.push(`  warning: ${w}`);
  }
  lines.push('');
  lines.push(
    result.valid
      ? 'OK: all DB-assembled subjects validate'
      : 'ERROR: one or more subjects fail DB-assembly validation',
  );
  return lines.join('\n');
}
