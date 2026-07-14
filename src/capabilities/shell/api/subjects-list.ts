// YUK-598 / YUK-628 — GET /api/subjects：learner 面的完整学科事实清单。
//
// 已注册 profile 与知识树里仅观测到的 raw domain 是两种不同事实：前者可用于
// goal / leaning，后者只能用于诚实显示和读侧筛选。响应用 configurationStatus 明确
// 区分，绝不把未知 domain 静默折成 general，也不把它注册成知识树实体。
//
// 字段仍逐项裁剪；promptFragments / judgePolicy 等 server-only AI 合同绝不下发。

import { knowledge } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';
import { isGeneralFallbackFor } from '@/server/subjects/resolution-cache';
import {
  type SubjectRegistry,
  getDefaultSubjectRegistry,
  normalizeSubjectKey,
} from '@/subjects/profile';
import { and, isNotNull, isNull } from 'drizzle-orm';

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

export async function GET(): Promise<Response> {
  try {
    // Lazy import keeps the pure projection available to the no-DB unit lane.
    const { db } = await import('@/db/client');
    const domains = await db
      .selectDistinct({ domain: knowledge.domain })
      .from(knowledge)
      .where(and(isNotNull(knowledge.domain), isNull(knowledge.archived_at)));
    return Response.json({
      subjects: buildSubjectsList(domains.flatMap((row) => row.domain ?? [])),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
