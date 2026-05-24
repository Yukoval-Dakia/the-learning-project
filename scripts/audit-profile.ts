import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultRegistry } from '@/core/capability/judges';
import type { CapabilityRegistry } from '@/core/capability/registry';
import { validateProfile } from '@/core/capability/validate-profile';
import { mathProfile } from '@/subjects/math/profile';
import { physicsProfile } from '@/subjects/physics/profile';
import type { SubjectProfile } from '@/subjects/profile-schema';
import { wenyanProfile } from '@/subjects/wenyan/profile';

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

export const auditSubjectProfiles: Record<string, SubjectProfile> = {
  wenyan: wenyanProfile,
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

export function auditProfiles(
  profiles: ProfileAuditInput = auditSubjectProfiles,
  registry: CapabilityRegistry = getDefaultRegistry(),
): ProfileAuditResult {
  const entries = toProfileList(profiles).map((profile) => {
    const result = validateProfile(profile, registry);
    return {
      id: profileId(profile),
      valid: result.valid,
      errors: result.errors,
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
  const result = auditProfiles();
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatProfileAuditReport(result));
  }
  return result.valid ? 0 : 1;
}

export function main(): void {
  process.exitCode = runCli();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
