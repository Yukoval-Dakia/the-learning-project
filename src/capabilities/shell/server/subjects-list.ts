// Learner subject list: registered profiles and raw domains seen only in the knowledge
// tree are different facts. configurationStatus keeps them distinct rather than
// folding unknown domains into general; server-only AI config never crosses the wire.

import { and, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { isGeneralFallbackFor } from '@/kernel/read-models/subject-trait-resolutions';
import {
  type SubjectRegistry,
  getDefaultSubjectRegistry,
  normalizeSubjectKey,
} from '@/subjects/profile';

export type SubjectConfigurationStatus = 'configured' | 'general-fallback' | 'unconfigured';

export interface LearnerSubjectRow {
  id: string;
  displayName: string;
  aliases: string[];
  renderConfig: {
    font_family: string;
    notation: string | null;
    code_highlight: string | null;
  };
  causeCategories: Array<{ id: string; label: string }>;
  isGeneralFallback: boolean | null;
  configurationStatus: SubjectConfigurationStatus;
}

function profileProjection(registry: SubjectRegistry, id: string): LearnerSubjectRow | null {
  const profile = registry.get(id);
  if (!profile) return null;
  const isGeneralFallback = isGeneralFallbackFor(profile.id);
  return {
    id: profile.id,
    displayName: profile.displayName,
    aliases: registry.listAliasesFor(profile.id),
    renderConfig: {
      font_family: profile.renderConfig.font_family,
      notation: profile.renderConfig.notation,
      code_highlight: profile.renderConfig.code_highlight,
    },
    causeCategories: profile.causeCategories.map((c) => ({ id: c.id, label: c.label })),
    isGeneralFallback,
    configurationStatus: isGeneralFallback === true ? 'general-fallback' : 'configured',
  };
}

/** Pure projection kept independently testable from the DB-backed route. */
export function buildSubjectsList(
  observedDomains: readonly string[],
  registry: SubjectRegistry = getDefaultSubjectRegistry(),
): LearnerSubjectRow[] {
  const configured = registry
    .getSelectableSubjectIds()
    .flatMap((id) => profileProjection(registry, id) ?? []);
  const general = registry.resolve(null);
  const unknownByKey = new Map<string, string>();

  for (const rawDomain of observedDomains) {
    const key = normalizeSubjectKey(rawDomain);
    if (!key || registry.resolveKnownSubjectId(key) !== null || unknownByKey.has(key)) continue;
    unknownByKey.set(key, key);
  }

  const unconfigured = [...unknownByKey.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
    .map(
      ([id, displayName]): LearnerSubjectRow => ({
        id,
        displayName,
        aliases: [],
        renderConfig: {
          font_family: general.renderConfig.font_family,
          notation: general.renderConfig.notation,
          code_highlight: general.renderConfig.code_highlight,
        },
        causeCategories: general.causeCategories.map((c) => ({ id: c.id, label: c.label })),
        // Unknown is not a registered profile that happens to use the general traits.
        isGeneralFallback: null,
        configurationStatus: 'unconfigured',
      }),
    );

  return [...configured, ...unconfigured];
}

export async function loadLearnerSubjects(db: Db): Promise<{ subjects: LearnerSubjectRow[] }> {
  const domains = await db
    .selectDistinct({ domain: knowledge.domain })
    .from(knowledge)
    .where(and(isNotNull(knowledge.domain), isNull(knowledge.archived_at)));
  return {
    subjects: buildSubjectsList(domains.flatMap((row) => row.domain ?? [])),
  };
}
