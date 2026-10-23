import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultRegistry } from '@/core/capability/judges';
import type { CapabilityRegistry } from '@/core/capability/registry';
import { validateProfile } from '@/core/capability/validate-profile';
import { auditEvaluationSemantics } from '@/subjects/evaluation-semantics-audit';
import { mathProfile } from '@/subjects/math/profile';
import { physicsProfile } from '@/subjects/physics/profile';
import { getDefaultSubjectRegistry } from '@/subjects/profile';
import type { SubjectProfile } from '@/subjects/profile-schema';
import { yuwenProfile } from '@/subjects/yuwen/profile';

export interface ProfileAuditEntry {
  id: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ProfileAuditResult {
  valid: boolean;
  total: number;
  invalid: number;
  warnings: number;
  entries: ProfileAuditEntry[];
}

export type ProfileAuditInput = readonly SubjectProfile[] | Record<string, SubjectProfile>;

// `auditProfiles()`'s default arg is this hardcoded 3-subject record, retained for unit tests that
// exercise validation failures with explicit args. The CLI walks the live registry instead, so a
// 4th subject enters automatically; this const is not the runCli source of truth.
export const auditSubjectProfiles: Record<string, SubjectProfile> = {
  yuwen: yuwenProfile,
  math: mathProfile,
  physics: physicsProfile,
};

function profileId(profile: SubjectProfile): string {
  return typeof profile.id === 'string' && profile.id.trim().length > 0
    ? profile.id
    : '<missing-id>';
}

function toProfileList(profiles: ProfileAuditInput): SubjectProfile[] {
  return Array.isArray(profiles) ? [...profiles] : Object.values(profiles);
}

// Builtin fail-closed semantics check, shared with --db mode via
// src/subjects/evaluation-semantics-audit.ts.

export function auditProfiles(
  profiles: ProfileAuditInput = auditSubjectProfiles,
  registry: CapabilityRegistry = getDefaultRegistry(),
): ProfileAuditResult {
  const entries = toProfileList(profiles).map((profile) => {
    const result = validateProfile(profile, registry);
    const semanticErrors = auditEvaluationSemantics(profile);
    return {
      id: profileId(profile),
      valid: result.valid && semanticErrors.length === 0,
      errors: [...result.errors, ...semanticErrors],
      warnings: result.warnings,
    };
  });
  const invalid = entries.filter((entry) => !entry.valid).length;
  const warnings = entries.reduce((count, entry) => count + entry.warnings.length, 0);

  return {
    valid: invalid === 0,
    total: entries.length,
    invalid,
    warnings,
    entries,
  };
}

export function formatProfileAuditReport(result: ProfileAuditResult): string {
  const lines = [
    'SubjectProfile audit',
    `profiles: ${result.total}`,
    `invalid: ${result.invalid}`,
    `warnings: ${result.warnings}`,
  ];

  for (const entry of result.entries) {
    if (entry.valid && entry.warnings.length === 0) {
      continue;
    }

    lines.push('');
    lines.push(`[${entry.id}] ${entry.valid ? 'valid' : 'invalid'}`);
    for (const error of entry.errors) {
      lines.push(`  error: ${error}`);
    }
    for (const warning of entry.warnings) {
      lines.push(`  warning: ${warning}`);
    }
  }

  lines.push('');
  lines.push(
    result.valid
      ? 'OK: all SubjectProfile declarations are valid'
      : 'ERROR: one or more SubjectProfile declarations are invalid',
  );

  return lines.join('\n');
}

export function runCli(args: string[] = process.argv.slice(2)): number {
  // Walk the live SubjectRegistry so every registered subject is audited, not the hardcoded
  // 3-subject default.
  const result = auditProfiles(getDefaultSubjectRegistry().listProfiles());
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatProfileAuditReport(result));
  }
  return result.valid ? 0 : 1;
}

// `--db` mode reads live DB bindings per subject and checks assembly, complementing the compile-
// time registry mode (it catches shared-trait drift and deprecated judges still wired). Report-only
// by default; --strict exits non-zero on invalid. Dynamic import keeps load-env before @/db/client
// and keeps the no-argument path DB-free.
export async function runDbCli(args: string[]): Promise<number> {
  await import('./load-env');
  const { db } = await import('@/db/client');
  const { auditProfilesFromDb, formatDbProfileAuditReport } = await import(
    '@/capabilities/observability/public'
  );
  const result = await auditProfilesFromDb(db);
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatDbProfileAuditReport(result));
  }
  return args.includes('--strict') && !result.valid ? 1 : 0;
}

export function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--db')) {
    // process.exit, not exitCode: the postgres pool has no idle_timeout, so its socket keeps the
    // event loop alive and the process never exits naturally.
    runDbCli(args)
      .then((rc) => process.exit(rc))
      .catch((err) => {
        console.error('[audit:profile --db] failed:', err);
        process.exit(1);
      });
  } else {
    process.exitCode = runCli(args);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
