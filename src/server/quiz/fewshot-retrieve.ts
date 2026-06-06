// YUK-225 (S2 slice 4) — 规范双轨 轨 2: few-shot 范例检索器.
//
// docs/superpowers/specs/2026-06-05-question-source-expansion-design.md §5 (轨 2)
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §0 实证3 / §5.3
//
// 轨 2 mechanism: when generating a (subject, kind) question, retrieve a few REAL,
// already-pooled questions of the same kind to show the model what a good item of
// that kind looks like — biased toward the highest-trust source tiers. This is the
// runtime, data-driven complement to 轨 1 (the static SKILL.md规范包).
//
// Implementation (实证3 裁决): SQL 直查既有 jsonb 包含原语，无新检索系统 / 无向量
// 检索 / 无新索引 / 不动 schema. Mirrors due-list.ts:208-225's
// `knowledge_ids @> jsonb` + `draft_status='active'` filter. tier 排序 cannot be
// expressed in SQL (tier is the deriveSourceTier推导函数), so SQL pulls a wider
// candidate set (LIMIT CANDIDATE_POOL) filtered by subject+kind+knowledge overlap
// + active, then the TS layer sorts by (tier → knowledge overlap → recency) and
// takes the top N (LIMIT 2-4). 0 命中降级: returns [].

import { type SourceTier, deriveSourceTier } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { sql } from 'drizzle-orm';

export interface FewShotExample {
  id: string;
  kind: string;
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  rubric_json: unknown;
  difficulty: number;
  knowledge_ids: string[];
  /** Source tier derived from provenance (1 authentic … 4 generated). */
  tier: SourceTier;
}

export interface FewShotRetrieveParams {
  db: Db;
  /** Question kind to match (canonical question.kind value, e.g. 'translation'). */
  kind: string;
  /** Knowledge ids the target question probes; used to rank by overlap. */
  knowledgeIds: string[];
  /** Max examples to return (spec §5: 2-4). Default 3. */
  limit?: number;
}

// Wider candidate pool pulled from SQL before the TS-layer tier sort, mirroring
// due-list.ts's LIMIT 20 — gives the tier ranking enough material to choose from.
const CANDIDATE_POOL = 20;
const DEFAULT_LIMIT = 3;

interface CandidateRow {
  id: string;
  kind: string;
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  rubric_json: unknown;
  difficulty: number;
  knowledge_ids: string[];
  source: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

function overlapCount(a: string[], b: Set<string>): number {
  let n = 0;
  for (const id of a) if (b.has(id)) n += 1;
  return n;
}

/**
 * Retrieve up to `limit` few-shot example questions of the given kind, biased to
 * high source tiers and knowledge-overlap with the target. Returns [] on 0 hits
 * (降级: caller injects no few-shot block).
 *
 * Filter: same kind + draft_status='active' (only pooled questions, never drafts —
 * mirrors due-list's `draft_status <> 'draft'` pool gate). When knowledgeIds is
 * non-empty we additionally require jsonb overlap so the SQL候选集 is already
 * topical; when empty we fall back to recent active questions of the kind.
 * Sort (TS layer): tier asc (1 best) → knowledge overlap desc → recency desc.
 */
export async function retrieveFewShotExamples(
  params: FewShotRetrieveParams,
): Promise<FewShotExample[]> {
  const { db, kind, knowledgeIds } = params;
  const limit = params.limit ?? DEFAULT_LIMIT;
  const knowledgeSet = new Set(knowledgeIds);

  // jsonb overlap predicate only when we have knowledge ids to match. The `@>`
  // containment check (due-list precedent) needs ONE id per call; for a multi-id
  // target we OR the per-id containment so any-overlap candidates are pulled.
  const overlapPredicate =
    knowledgeIds.length > 0
      ? sql`AND (${sql.join(
          knowledgeIds.map((id) => sql`knowledge_ids @> ${JSON.stringify([id])}::jsonb`),
          sql` OR `,
        )})`
      : sql``;

  const rows = (await db.execute(sql`
      SELECT id, kind, prompt_md, reference_md, choices_md, rubric_json, difficulty,
             knowledge_ids, source, metadata, created_at
      FROM question
      WHERE kind = ${kind}
        AND draft_status = 'active'
        ${overlapPredicate}
      ORDER BY created_at DESC
      LIMIT ${CANDIDATE_POOL}
    `)) as unknown as CandidateRow[];

  if (rows.length === 0) return [];

  const ranked = rows
    .map((row) => {
      const { tier } = deriveSourceTier({ source: row.source, metadata: row.metadata });
      return {
        row,
        tier,
        overlap: overlapCount(row.knowledge_ids ?? [], knowledgeSet),
        createdAt: row.created_at instanceof Date ? row.created_at.getTime() : 0,
      };
    })
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier; // tier 1 (authentic) first
      if (a.overlap !== b.overlap) return b.overlap - a.overlap; // more overlap first
      return b.createdAt - a.createdAt; // most recent first
    })
    .slice(0, limit);

  return ranked.map(({ row, tier }) => ({
    id: row.id,
    kind: row.kind,
    prompt_md: row.prompt_md,
    reference_md: row.reference_md,
    choices_md: row.choices_md ?? null,
    rubric_json: row.rubric_json ?? null,
    difficulty: row.difficulty,
    knowledge_ids: row.knowledge_ids ?? [],
    tier,
  }));
}

/**
 * Render retrieved few-shot examples into a prompt block injected into the
 * generation prompt. Empty input → empty string (降级链: no block). Pure function
 * so it is unit-testable without a Db.
 */
export function renderFewShotBlock(examples: FewShotExample[]): string {
  if (examples.length === 0) return '';
  const lines: string[] = [
    '已入库的同题型优质范例（按可信度排序，供参考其结构与设问风格，**不要照抄题面**）：',
  ];
  examples.forEach((ex, i) => {
    lines.push(`\n范例 ${i + 1}（tier ${ex.tier}，难度 ${ex.difficulty}）：`);
    lines.push(`题面：${ex.prompt_md}`);
    if (ex.choices_md && ex.choices_md.length > 0) {
      lines.push(`选项：${ex.choices_md.join(' / ')}`);
    }
    if (ex.reference_md) {
      lines.push(`参考答案：${ex.reference_md}`);
    }
  });
  return lines.join('\n');
}
