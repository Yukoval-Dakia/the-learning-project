import {
  CauseCategoryDeclaration,
  RenderConfig,
  SchedulingHints,
} from '@/core/schema/profile-decl';
import { type SubjectProfile, SubjectProfileSchema } from '@/subjects/profile-schema';
import type { CapabilityRegistry } from './registry';

export interface ProfileValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function firstIssueMessage(result: { success: false; error: { issues: { message: string }[] } }) {
  return result.error.issues[0]?.message ?? 'invalid value';
}

function formatSchemaIssue(issue: { path: (string | number)[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
  return `SubjectProfile.${path}: ${issue.message}`;
}

function validateCauseCategories(profile: SubjectProfile, errors: string[]): void {
  if (!Array.isArray(profile.causeCategories) || profile.causeCategories.length === 0) {
    errors.push(`[${profile.id}] causeCategories must have at least one entry`);
    return;
  }

  const seenIds = new Set<string>();
  for (const category of profile.causeCategories) {
    const parsed = CauseCategoryDeclaration.safeParse(category);
    if (!parsed.success) {
      errors.push(
        `[${profile.id}] causeCategory '${String(
          category.id,
        )}' has invalid format: ${firstIssueMessage(parsed)}`,
      );
      continue;
    }

    if (seenIds.has(category.id)) {
      errors.push(`[${profile.id}] causeCategory duplicate id: '${category.id}'`);
    }
    seenIds.add(category.id);
  }
}

function validateJudgeCapabilities(
  profile: SubjectProfile,
  registry: CapabilityRegistry,
  errors: string[],
  warnings: string[],
): void {
  if (!Array.isArray(profile.judgeCapabilities)) {
    errors.push(`[${profile.id}] judgeCapabilities must be an array`);
    return;
  }

  const seenCapabilities = new Set<string>();
  for (const capabilityId of profile.judgeCapabilities) {
    if (typeof capabilityId !== 'string' || capabilityId.trim().length === 0) {
      errors.push(`[${profile.id}] judgeCapabilities contains an empty id`);
      continue;
    }
    if (seenCapabilities.has(capabilityId)) {
      errors.push(`[${profile.id}] judgeCapability duplicate id: '${capabilityId}'`);
      continue;
    }
    seenCapabilities.add(capabilityId);

    const runner = registry.resolveJudge(capabilityId);
    if (!runner) {
      errors.push(`[${profile.id}] judgeCapability '${capabilityId}' not found in registry`);
      continue;
    }
    if (runner.manifest.stability === 'deprecated') {
      const replacement = runner.manifest.replaced_by
        ? ` (replaced by '${runner.manifest.replaced_by}')`
        : '';
      warnings.push(
        `[${profile.id}] judgeCapability '${capabilityId}' is deprecated${replacement}`,
      );
    }
  }

  for (const route of profile.judgePolicy.preferredRoutes) {
    if (registry.resolveJudge(route) && !seenCapabilities.has(route)) {
      errors.push(
        `[${profile.id}] judgePolicy.preferredRoutes includes registry-backed route '${route}' but judgeCapabilities does not declare it`,
      );
    }
  }
}

export function validateProfile(
  profile: SubjectProfile,
  registry: CapabilityRegistry,
): ProfileValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsedProfile = SubjectProfileSchema.safeParse(profile);
  if (!parsedProfile.success) {
    return {
      valid: false,
      errors: parsedProfile.error.issues.map(formatSchemaIssue),
      warnings,
    };
  }
  const validProfile = parsedProfile.data;

  if (typeof validProfile.version !== 'string' || validProfile.version.trim().length === 0) {
    errors.push(`[${validProfile.id}] version must be a non-empty string`);
  }

  validateCauseCategories(validProfile, errors);
  validateJudgeCapabilities(validProfile, registry, errors, warnings);

  const renderConfig = RenderConfig.safeParse(validProfile.renderConfig);
  if (!renderConfig.success) {
    errors.push(`[${validProfile.id}] renderConfig is invalid: ${firstIssueMessage(renderConfig)}`);
  }

  const schedulingHints = SchedulingHints.safeParse(validProfile.schedulingHints);
  if (!schedulingHints.success) {
    errors.push(
      `[${validProfile.id}] schedulingHints is invalid: ${firstIssueMessage(schedulingHints)}`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
