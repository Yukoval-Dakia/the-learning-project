// YUK-601 PR7 (v3.2 §7，v2 PR7 原样保留) — 装配粒度漂移审计：全部 subject 行
// （含 general 与 retired）逐一「读六绑定 → assemble → validateProfile」。
// 与编译期 audit:profile（scripts/audit-profile.ts 无参模式，走内存 registry）
// 互补：本审计读 DB 活绑定，抓「共享 trait 被编辑后某绑定科目装配变坏」
// 「deprecated judge 仍被活装配引用」这类只在 DB 面存在的漂移。
// report-only 语义由调用方裁（CLI 默认 report-only；--strict / 夜间 cron 失败可见）。
// 复用 validateSubject（subject-control-write.ts）——审计与写门预检同一条装配
// 路径，防双真相源。

import type { Db } from '@/db/client';
import { subject } from '@/db/schema';
import { validateSubject } from '@/server/subjects/subject-control-write';
import { asc } from 'drizzle-orm';

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
    entries.push({
      id: row.id,
      displayName: row.displayName,
      retired: row.retiredAt !== null,
      valid: result?.valid ?? false,
      errors: result?.errors ?? ['subject vanished mid-audit'],
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
