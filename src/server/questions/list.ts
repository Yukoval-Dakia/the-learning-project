// YUK-280 P4 (YUK-203) — GET /api/questions list reader.
//
// docs/superpowers/plans/2026-06-07-yuk280-question-bank-api.md §2 (A1a/A1b/A1c)
//
// Multi-axis question-bank list reader. Three composed capabilities:
//   A1a 基础列表 — SQL axes (knowledge_ids / source / kind / difficulty /
//                 visual_complexity / draft) + offset pagination.
//   A1b grounding — source_tier is a DERIVED (provenance-driven) value, NOT a
//                 column. Per the D-P4-1 red line we NEVER express tier in SQL
//                 WHERE/ORDER BY; we narrow the candidate set with the SQL axes,
//                 then deriveSourceTier + compareBySourceTierThenWhitelist purely
//                 in memory. (Same teaching as sourcing-sequence.ts:98-103 —
//                 truncating in SQL before the in-memory tier sort would drop a
//                 newer high-tier row in favour of older low-tier ones.)
//   A1c variant families — group by root family / expand one root's full family.
//
// 量级假设 (plan §0): a single user's question bank is hundreds-to-thousands of
// rows (SPEC-given), bounded by the SQL axes above. The CANDIDATE_CAP below is an
// OOM guard, NOT a business limit — it only bites when the tier/family in-memory
// path must fetch the full WHERE-hit set (it cannot SQL-paginate, see A1b).

import { type SQL, and, asc, eq, sql } from 'drizzle-orm';

import {
  type SourceTier,
  type SourceTierName,
  compareBySourceTierThenWhitelist,
  deriveSourceTier,
} from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';

// Truncation threshold for list-item `prompt_md` (detail page serves the full
// text). Keeps the list payload bounded on long prompts. A trailing ellipsis
// marks truncation so a consumer never mistakes a cut prompt for the whole text.
const PROMPT_PREVIEW_CHARS = 200;

// OOM guard for the in-memory derive path (A1b/A1c). When a tier filter / tier
// sort / family aggregation is requested the SQL stage CANNOT limit/offset (it
// would drop high-tier rows before the in-memory rank — sourcing-sequence:98-103
// 同款教训), so we fetch the full WHERE-hit set and cap it here. A single user's
// bank is hundreds-to-thousands of rows, so this never bites in practice; when it
// does, `truncated: true` is surfaced and a warn is logged. NOT a business limit.
const CANDIDATE_CAP = 2000;

// OF-2 (plan §12) — read metadata.web_sourced.whitelist_match for the within-
// tier-2 demotion comparator. Returns null for non-web_sourced rows. Mirrors
// sourcing-sequence:70-76 readWhitelistMatch verbatim (the ORDER logic itself is
// the shared compareBySourceTierThenWhitelist comparator — only this tiny jsonb
// read is local).
function readWhitelistMatch(metadata: Record<string, unknown> | null): boolean | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const webSourced = (metadata as Record<string, unknown>).web_sourced;
  if (!webSourced || typeof webSourced !== 'object') return null;
  const match = (webSourced as Record<string, unknown>).whitelist_match;
  return typeof match === 'boolean' ? match : null;
}

function previewPrompt(promptMd: string): string {
  if (promptMd.length <= PROMPT_PREVIEW_CHARS) return promptMd;
  return `${promptMd.slice(0, PROMPT_PREVIEW_CHARS)}…`;
}

export type QuestionListSortBy = 'created_at' | 'source_tier';

export interface ListQuestionsParams {
  // 任一匹配 → OR of `knowledge_ids @> [id]` (复用 sourcing-sequence:114 容器写法).
  knowledgeIds?: string[];
  source?: string;
  kind?: string; // canonical persisted form; list is an exact axis (no kindsMatch normalisation).
  difficulty?: number; // 1-5
  visualComplexity?: string; // nullable column: only filters when a value is passed.
  // A1b grounding axis (in-memory derive only — never SQL).
  sourceTier?: SourceTier[];
  sortBy?: QuestionListSortBy; // default 'created_at' (desc); 'source_tier' → comparator.
  // A1c variant families.
  groupByFamily?: boolean;
  expandRoot?: string;
  // draft exclusion (default false → draft 排除惯例).
  includeDrafts?: boolean;
  limit: number; // clamp 1..200
  offset: number; // >= 0
}

export interface QuestionListItem {
  id: string;
  kind: string;
  prompt_md: string; // truncated preview (see PROMPT_PREVIEW_CHARS).
  source: string;
  source_tier: { tier: SourceTier; name: SourceTierName };
  difficulty: number;
  visual_complexity: string | null;
  knowledge_ids: string[];
  root_question_id: string | null;
  variant_depth: number;
  draft_status: string | null;
  created_at_sec: number; // unix seconds — matches全仓 API 时间形 (learning-items/timeline).
}

export interface QuestionFamily {
  root_question_id: string; // family key = root_question_id ?? id of the representative.
  root_prompt_md: string; // truncated preview of the representative.
  variant_count: number;
  max_variant_depth: number;
  member_ids: string[];
  representative: QuestionListItem; // the root (or shallowest) member.
}

export interface ListQuestionsResult {
  // Plain / expand-root / tier list (mutually exclusive with `families`).
  items: QuestionListItem[];
  // Family-aggregated view (only when groupByFamily). `items` is empty then.
  families: QuestionFamily[] | null;
  total: number; // count over the same filter set (post in-memory filter when tier-filtered).
  // true when CANDIDATE_CAP clipped the in-memory candidate set (OOM guard hit).
  truncated: boolean;
  computed_at_sec: number;
}

// The columns the in-memory derive path needs (source + metadata for
// deriveSourceTier / readWhitelistMatch, plus the projected list fields).
const CANDIDATE_COLUMNS = {
  id: question.id,
  kind: question.kind,
  prompt_md: question.prompt_md,
  source: question.source,
  metadata: question.metadata,
  difficulty: question.difficulty,
  visual_complexity: question.visual_complexity,
  knowledge_ids: question.knowledge_ids,
  root_question_id: question.root_question_id,
  variant_depth: question.variant_depth,
  draft_status: question.draft_status,
  created_at: question.created_at,
} as const;

type CandidateRow = {
  id: string;
  kind: string;
  prompt_md: string;
  source: string;
  metadata: Record<string, unknown> | null;
  difficulty: number;
  visual_complexity: string | null;
  knowledge_ids: string[];
  root_question_id: string | null;
  variant_depth: number;
  draft_status: string | null;
  created_at: Date;
};

// A candidate row + its derived tier/whitelist (computed once, reused for filter,
// sort, and the per-item source_tier projection).
interface DerivedCandidate {
  row: CandidateRow;
  tier: SourceTier;
  tierName: SourceTierName;
  whitelistMatch: boolean | null;
}

function buildSqlFilters(params: ListQuestionsParams): SQL[] {
  const filters: SQL[] = [];

  if (params.knowledgeIds && params.knowledgeIds.length > 0) {
    // OR of `@>` per id — reuses the established containment pattern
    // (note-page:262 / sourcing-sequence:114). A `?|` operator is intentionally
    // avoided (drizzle has no first-class helper and it bypasses jsonb_path_ops).
    const containers = params.knowledgeIds.map(
      (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
    );
    filters.push(sql`(${sql.join(containers, sql` OR `)})`);
  }
  if (params.source !== undefined) filters.push(eq(question.source, params.source));
  if (params.kind !== undefined) filters.push(eq(question.kind, params.kind));
  if (params.difficulty !== undefined) filters.push(eq(question.difficulty, params.difficulty));
  if (params.visualComplexity !== undefined) {
    filters.push(eq(question.visual_complexity, params.visualComplexity));
  }
  if (!params.includeDrafts) {
    // draft 排除惯例 (sourcing-sequence:116 / due-list): nullable column must
    // carry the IS NULL branch, not a bare `<> 'draft'`.
    filters.push(sql`(${question.draft_status} IS NULL OR ${question.draft_status} <> 'draft')`);
  }
  return filters;
}

function toListItem(c: DerivedCandidate): QuestionListItem {
  const { row } = c;
  return {
    id: row.id,
    kind: row.kind,
    prompt_md: previewPrompt(row.prompt_md),
    source: row.source,
    source_tier: { tier: c.tier, name: c.tierName },
    difficulty: row.difficulty,
    visual_complexity: row.visual_complexity,
    knowledge_ids: row.knowledge_ids ?? [],
    root_question_id: row.root_question_id,
    variant_depth: row.variant_depth,
    draft_status: row.draft_status,
    created_at_sec: Math.floor(row.created_at.getTime() / 1000),
  };
}

function deriveCandidate(row: CandidateRow): DerivedCandidate {
  const metadata = row.metadata ?? null;
  const { tier, name } = deriveSourceTier({ source: row.source, metadata });
  return { row, tier, tierName: name, whitelistMatch: readWhitelistMatch(metadata) };
}

// Fetch the full WHERE-hit candidate set (capped) for the in-memory derive path.
// ORDER BY created_at ASC is the stable BASE order the comparator relies on
// (compareBySourceTierThenWhitelist is a stable secondary sort within equal keys).
async function fetchCandidates(
  db: Db,
  filters: SQL[],
): Promise<{ rows: CandidateRow[]; truncated: boolean }> {
  const rows = (await db
    .select(CANDIDATE_COLUMNS)
    .from(question)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(question.created_at), asc(question.id))
    // CANDIDATE_CAP + 1 so we can detect (and flag) truncation without an extra count.
    .limit(CANDIDATE_CAP + 1)) as CandidateRow[];

  if (rows.length > CANDIDATE_CAP) {
    console.warn(
      '[questions/list] candidate set exceeded CANDIDATE_CAP; truncating in-memory derive',
      { cap: CANDIDATE_CAP },
    );
    return { rows: rows.slice(0, CANDIDATE_CAP), truncated: true };
  }
  return { rows, truncated: false };
}

const emptyResult = (): ListQuestionsResult => ({
  items: [],
  families: null,
  total: 0,
  truncated: false,
  computed_at_sec: Math.floor(Date.now() / 1000),
});

/**
 * List questions with multi-axis SQL filtering, in-memory grounding-tier
 * filter/sort, and variant-family aggregation/expansion.
 *
 * Path selection (mutually exclusive, resolved upstream by the route's zod
 * refine; here we honour the precedence expandRoot > groupByFamily > list):
 *   - expandRoot: return one root's full family, depth-ordered.
 *   - groupByFamily: aggregate candidates into families, paginate families.
 *   - otherwise: a flat list (with optional tier filter/sort).
 */
export async function listQuestions(
  db: Db,
  params: ListQuestionsParams,
): Promise<ListQuestionsResult> {
  const computedAtSec = Math.floor(Date.now() / 1000);

  if (params.expandRoot !== undefined) {
    return expandRootFamily(db, params, computedAtSec);
  }

  const filters = buildSqlFilters(params);
  const { rows, truncated } = await fetchCandidates(db, filters);
  const derived = rows.map(deriveCandidate);

  if (params.groupByFamily) {
    return aggregateFamilies(derived, params, truncated, computedAtSec);
  }
  return flatList(derived, params, truncated, computedAtSec);
}

// ── A1a/A1b: flat list (with optional tier filter + tier/created_at sort) ──────
function flatList(
  derived: DerivedCandidate[],
  params: ListQuestionsParams,
  truncated: boolean,
  computedAtSec: number,
): ListQuestionsResult {
  let filtered = derived;
  if (params.sourceTier && params.sourceTier.length > 0) {
    const wanted = new Set<SourceTier>(params.sourceTier);
    filtered = filtered.filter((c) => wanted.has(c.tier));
  }

  // Base order from SQL is created_at ASC (stable secondary-sort base).
  if (params.sortBy === 'source_tier') {
    // High tier first (1→4) + OF-2 demotion; the created_at-asc base order
    // survives within equal (tier, demotion) keys (comparator returns 0).
    filtered = [...filtered].sort((a, b) =>
      compareBySourceTierThenWhitelist(
        { tier: a.tier, whitelistMatch: a.whitelistMatch },
        { tier: b.tier, whitelistMatch: b.whitelistMatch },
      ),
    );
  } else {
    // Default list semantics are newest-first; the SQL base order is created_at
    // ASC (needed as the comparator base), so reverse it here for the non-tier
    // path. Stable reverse: equal created_at keeps insertion order reversed,
    // which is acceptable for a created_at-keyed list.
    filtered = [...filtered].reverse();
  }

  const total = filtered.length;
  const page = filtered.slice(params.offset, params.offset + params.limit);
  return {
    items: page.map(toListItem),
    families: null,
    total,
    truncated,
    computed_at_sec: computedAtSec,
  };
}

// ── A1c (1): family aggregation ───────────────────────────────────────────────
function familyKey(c: DerivedCandidate): string {
  // root's own root_question_id is null → it IS the family root, key by its id.
  return c.row.root_question_id ?? c.row.id;
}

function aggregateFamilies(
  derived: DerivedCandidate[],
  params: ListQuestionsParams,
  truncated: boolean,
  computedAtSec: number,
): ListQuestionsResult {
  // Optional tier filter applies BEFORE grouping (a tier-filtered family view
  // groups only the surviving members). Mirrors the flat-list filter order.
  let members = derived;
  if (params.sourceTier && params.sourceTier.length > 0) {
    const wanted = new Set<SourceTier>(params.sourceTier);
    members = members.filter((c) => wanted.has(c.tier));
  }

  const groups = new Map<string, DerivedCandidate[]>();
  for (const c of members) {
    const key = familyKey(c);
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }

  const families: QuestionFamily[] = [];
  for (const [key, bucket] of groups) {
    // representative = the shallowest member (root has variant_depth 0); ties
    // break on created_at asc (bucket already in created_at-asc base order).
    const representative = bucket.reduce((best, c) =>
      c.row.variant_depth < best.row.variant_depth ? c : best,
    );
    const maxDepth = bucket.reduce((m, c) => Math.max(m, c.row.variant_depth), 0);
    families.push({
      root_question_id: key,
      root_prompt_md: previewPrompt(representative.row.prompt_md),
      variant_count: bucket.length,
      max_variant_depth: maxDepth,
      member_ids: bucket.map((c) => c.row.id),
      representative: toListItem(representative),
    });
  }

  // Newest-first family ordering by the representative's created_at (mirrors the
  // flat list's newest-first default).
  families.sort((a, b) => b.representative.created_at_sec - a.representative.created_at_sec);

  const total = families.length;
  const page = families.slice(params.offset, params.offset + params.limit);
  return {
    items: [],
    families: page,
    total,
    truncated,
    computed_at_sec: computedAtSec,
  };
}

// ── A1c (2): expand one root's full family ────────────────────────────────────
async function expandRootFamily(
  db: Db,
  params: ListQuestionsParams,
  computedAtSec: number,
): Promise<ListQuestionsResult> {
  const rootKey = params.expandRoot as string;
  const members = await loadFamilyMembers(db, rootKey, !params.includeDrafts);
  if (members.length === 0) return { ...emptyResult(), computed_at_sec: computedAtSec };

  const derived = members.map(deriveCandidate);
  // depth asc, created_at asc — the family-tree reading order.
  derived.sort((a, b) => {
    if (a.row.variant_depth !== b.row.variant_depth) {
      return a.row.variant_depth - b.row.variant_depth;
    }
    return a.row.created_at.getTime() - b.row.created_at.getTime();
  });

  const total = derived.length;
  const page = derived.slice(params.offset, params.offset + params.limit);
  return {
    items: page.map(toListItem),
    families: null,
    total,
    truncated: false,
    computed_at_sec: computedAtSec,
  };
}

/**
 * Load every member of a variant family (the root plus all its variants),
 * keyed by `rootKey`. Shared by the list `expand_root` path and the detail
 * reader's family panel. `excludeDrafts` mirrors the list's draft 排除惯例 — the
 * detail reader passes false (it shows drafts), the list passes true by default.
 *
 * Family membership = `root_question_id = rootKey OR id = rootKey` (the root has
 * a null root_question_id and is matched by its own id).
 */
export async function loadFamilyMembers(
  db: Db,
  rootKey: string,
  excludeDrafts: boolean,
): Promise<CandidateRow[]> {
  const membership = sql`(${question.root_question_id} = ${rootKey} OR ${question.id} = ${rootKey})`;
  const where = excludeDrafts
    ? and(
        membership,
        sql`(${question.draft_status} IS NULL OR ${question.draft_status} <> 'draft')`,
      )
    : membership;
  return (await db
    .select(CANDIDATE_COLUMNS)
    .from(question)
    .where(where)
    .orderBy(
      asc(question.variant_depth),
      asc(question.created_at),
      asc(question.id),
    )) as CandidateRow[];
}
