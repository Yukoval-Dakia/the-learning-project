// GET /api/questions list reader: multi-axis SQL filtering, derived source-tier
// filter/sort, and variant-family aggregation.
//
// source_tier is provenance-derived, never a column, so tier filtering and ranking
// happen in memory after the SQL axes narrow the candidate set. Truncating in SQL
// first would drop newer high-tier rows.
//
// A single user's bank is hundreds to low thousands of rows; CANDIDATE_CAP is an
// OOM guard, not a business limit.

import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import {
  batchResolveSubjectDisplayIds,
  resolveSubjectRenderNotation,
} from '@/capabilities/knowledge/public';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import {
  type SourceTier,
  type SourceTierName,
  compareBySourceTierThenWhitelist,
  deriveSourceTier,
} from '@/core/schema/provenance';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import { knowledge, question } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { canonicalKindToPersistedForms } from '@/subjects/question-kind';
import {
  type QuestionServing,
  type ServingCounts,
  UNKNOWN_SERVING,
  countQuestionServing,
  questionServingSet,
  readQuestionServing,
} from './question-serving';

// List preview cap; the detail page serves the full text. The ellipsis marks
// truncation so a consumer never mistakes a preview for the whole prompt.
const PROMPT_PREVIEW_CHARS = 200;

// OOM guard for the in-memory derive path. The SQL stage cannot limit/offset there
// without dropping high-tier rows, so fetch the full hit set and cap it here.
// Truncation sets `truncated` and logs a warn. Not a business limit.
const CANDIDATE_CAP = 2000;

// Read metadata.web_sourced.whitelist_match for the within-tier demotion comparator.
// Only this jsonb read is local; the ordering itself is shared.
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

export type QuestionListSortBy = 'created_at' | 'source_tier' | 'difficulty';
export type QuestionListSortDir = 'asc' | 'desc';
export type QuestionListDraftStatus = 'all' | 'active' | 'draft';

export interface ListQuestionsParams {
  // Any match -> OR of knowledge_ids containment.
  knowledgeIds?: string[];
  // Derived subject axis: the route resolves subject -> knowledge ids. An empty set
  // means the subject labels no questions, so the result is empty, not unfiltered.
  subjectKnowledgeIds?: string[];
  source?: string;
  // Expand the requested canonical kind to every persisted form, because historical
  // rows store profile vocabulary. Still a pure SQL axis.
  kind?: string;
  difficulty?: number; // 1-5
  difficulties?: number[]; // repeated difficulty params; OR semantics.
  visualComplexity?: string; // nullable column: only filters when a value is passed.
  search?: string; // prompt/id/knowledge-name substring.
  // Grounding axis, derived in memory only.
  sourceTier?: SourceTier[];
  sortBy?: QuestionListSortBy; // default 'created_at' (desc); 'source_tier' uses the comparator.
  sortDir?: QuestionListSortDir; // default desc; ignored by source_tier ranking.
  // Variant families.
  groupByFamily?: boolean;
  expandRoot?: string;
  // default false -> drafts excluded.
  includeDrafts?: boolean;
  draftStatus?: QuestionListDraftStatus;
  // status=not_servable: filter held questions before SQL pagination.
  notServable?: boolean;
  // Return pagination-independent hold counts alongside the page.
  includeServingCounts?: boolean;
  // Page enrichment opt-in (subject, labels, composite children). Only the default
  // SQL-paginated path uses it, so tier/family/tool paths add no queries.
  enrich?: boolean;
  limit: number; // clamp 1..200
  offset: number; // >= 0
  cursor?: string;
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
  // Composite linkage. Top-level rows always have parent_question_id null (parts are
  // excluded); the field keeps the shared shape for composite-aware readers.
  parent_question_id: string | null;
  part_index: number | null;
  draft_status: string | null;
  created_at_sec: number; // Unix seconds, matching the API time shape.
  // Page enrichment (opt-in via `enrich`; null when not requested). All additive,
  // computed only on the bank-UI path.
  subject: string | null;
  // notation comes from the server's resolvable registry, so retired subjects keep
  // their original rendering.
  notation: string | null;
  knowledge_labels: { id: string; name: string }[] | null;
  is_composite: boolean;
  children: QuestionListItem[];
  // Serving hold projection (group-level: a composite child shares its parent's).
  // Attached by listQuestions' post-pass on every path.
  serving: QuestionServing;
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
  page: {
    limit: number;
    offset: number;
    has_more: boolean;
    next_cursor: string | null;
  };
  // Present only when notServable or includeServingCounts was set.
  serving_counts?: ServingCounts;
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
  parent_question_id: question.parent_question_id,
  part_index: question.part_index,
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
  parent_question_id: string | null;
  part_index: number | null;
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

// OR of knowledge_ids containment. Avoid `?|`: there is no first-class drizzle
// helper and it bypasses jsonb_path_ops.
function knowledgeContainmentOr(ids: string[]): SQL {
  const containers = ids.map(
    (id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`,
  );
  return sql`(${sql.join(containers, sql` OR `)})`;
}

function buildSqlFilters(params: ListQuestionsParams): SQL[] {
  const filters: SQL[] = [];

  if (params.knowledgeIds && params.knowledgeIds.length > 0) {
    filters.push(knowledgeContainmentOr(params.knowledgeIds));
  }
  // Subject axis ANDs with the knowledge axis. An empty set forces an empty result,
  // which stays distinguishable from "no subject filter".
  if (params.subjectKnowledgeIds !== undefined) {
    filters.push(
      params.subjectKnowledgeIds.length > 0
        ? knowledgeContainmentOr(params.subjectKnowledgeIds)
        : sql`false`,
    );
  }
  // Exclude question_part rows: they are reachable through the parent's parts[],
  // not as standalone list rows. Variant members stay; family grouping handles them.
  filters.push(sql`(${question.parent_question_id} IS NULL)`);
  // Fixed-window diagnostics are learner-facing only through /api/review/due.
  // Never expose future probes or reference answers through the question bank.
  filters.push(ne(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE));
  // Dismissed draft tombstones are dead rows on every path, including
  // include_drafts. Kept off draft_status because the pool predicate treats any
  // non-'draft' value as pool-visible.
  filters.push(sql`(${question.metadata} -> 'dismissed_at') IS NULL`);
  if (params.source !== undefined) filters.push(eq(question.source, params.source));
  if (params.kind !== undefined) {
    // Match every persisted form; a single-element set is an exact match.
    filters.push(inArray(question.kind, canonicalKindToPersistedForms(params.kind)));
  }
  const difficulties = params.difficulties?.length
    ? [...new Set(params.difficulties)]
    : params.difficulty !== undefined
      ? [params.difficulty]
      : [];
  if (difficulties.length > 0) filters.push(inArray(question.difficulty, difficulties));
  if (params.visualComplexity !== undefined) {
    filters.push(eq(question.visual_complexity, params.visualComplexity));
  }
  if (params.search?.trim()) {
    const escaped = params.search.trim().replace(/[\\%_]/g, '\\$&');
    const pattern = `%${escaped}%`;
    filters.push(
      or(
        ilike(question.prompt_md, pattern),
        ilike(question.id, pattern),
        sql`EXISTS (
          SELECT 1
          FROM ${knowledge}
          WHERE ${knowledge.id} IN (
            SELECT jsonb_array_elements_text(${question.knowledge_ids})
          )
          AND ${knowledge.archived_at} IS NULL
          AND ${knowledge.name} ILIKE ${pattern}
        )`,
      ) as SQL,
    );
  }
  if (params.draftStatus === 'draft') {
    filters.push(eq(question.draft_status, 'draft'));
  } else if (params.draftStatus === 'active') {
    filters.push(notDraftPredicate(question.draft_status));
  } else if (params.draftStatus === undefined && !params.includeDrafts) {
    // Nullable column needs the IS NULL branch, not a bare <> 'draft'.
    filters.push(notDraftPredicate(question.draft_status));
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
    parent_question_id: row.parent_question_id,
    part_index: row.part_index,
    draft_status: row.draft_status,
    created_at_sec: Math.floor(row.created_at.getTime() / 1000),
    // Enrichment stays unset here; enrichItems fills subject/labels/composite/children.
    subject: null,
    notation: null,
    knowledge_labels: null,
    is_composite: false,
    children: [],
    // Placeholder — listQuestions' attachServing post-pass always overwrites it.
    serving: { ...UNKNOWN_SERVING },
  };
}

function deriveCandidate(row: CandidateRow): DerivedCandidate {
  const metadata = row.metadata ?? null;
  const { tier, name } = deriveSourceTier({ source: row.source, metadata });
  return { row, tier, tierName: name, whitelistMatch: readWhitelistMatch(metadata) };
}

// Fetch the full hit set (capped) for the in-memory path. created_at ASC is the
// stable base order the tier comparator relies on.
async function fetchCandidates(
  db: Db | Tx,
  filters: SQL[],
  complete = false,
): Promise<{ rows: CandidateRow[]; truncated: boolean }> {
  const query = db
    .select(CANDIDATE_COLUMNS)
    .from(question)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(question.created_at), asc(question.id));
  const rows = await (complete ? query : query.limit(CANDIDATE_CAP + 1));

  if (!complete && rows.length > CANDIDATE_CAP) {
    console.warn(
      '[questions/list] candidate set exceeded CANDIDATE_CAP; truncating in-memory derive',
      { cap: CANDIDATE_CAP },
    );
    return { rows: rows.slice(0, CANDIDATE_CAP), truncated: true };
  }
  return { rows, truncated: false };
}

function pageInfo(
  total: number,
  returned: number,
  params: Pick<ListQuestionsParams, 'limit' | 'offset'>,
  nextCursor: string | null = null,
  hasMore: boolean = params.offset + returned < total,
): ListQuestionsResult['page'] {
  return {
    limit: params.limit,
    offset: params.offset,
    has_more: hasMore,
    next_cursor: nextCursor,
  };
}

const emptyResult = (params: ListQuestionsParams): ListQuestionsResult => ({
  items: [],
  families: null,
  total: 0,
  truncated: false,
  page: pageInfo(0, 0, params),
  computed_at_sec: Math.floor(Date.now() / 1000),
});

/** Attach the serving projection to every emitted item in one batched read, never per item. */
async function attachServingToItems(db: Db | Tx, items: QuestionListItem[]): Promise<void> {
  const flat: QuestionListItem[] = [];
  const collect = (item: QuestionListItem) => {
    flat.push(item);
    for (const child of item.children) flat.push(child);
  };
  for (const item of items) collect(item);
  // Per-item attachment: a composite child reports its own per-part verdict.
  const serving = await readQuestionServing(
    db,
    flat.map((item) => item.id),
  );
  for (const item of flat) {
    item.serving = serving.byId.get(item.id) ?? { ...UNKNOWN_SERVING };
  }
}

/** Multi-axis list. Precedence: expandRoot > groupByFamily > flat list. */
export async function listQuestions(
  db: Db,
  params: ListQuestionsParams,
): Promise<ListQuestionsResult> {
  // The SQL aggregate and the frozen-contract batches must see the same revisions.
  if (params.notServable || params.includeServingCounts) {
    return db.transaction((tx) => readQuestions(tx, params), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }
  return readQuestions(db, params);
}

async function readQuestions(
  db: Db | Tx,
  params: ListQuestionsParams,
): Promise<ListQuestionsResult> {
  const computedAtSec = Math.floor(Date.now() / 1000);
  const needServingPass = params.notServable === true || params.includeServingCounts === true;

  if (params.expandRoot !== undefined) {
    return expandRootFamily(db, params, computedAtSec);
  }

  const filters = buildSqlFilters(params);

  const tierFiltered = params.sourceTier !== undefined && params.sourceTier.length > 0;
  const tierSorted = params.sortBy === 'source_tier';
  let servingCounts: ServingCounts | undefined;
  if (needServingPass) {
    // Tier stays derived in TS. Only this opt-in combination needs the complete
    // metadata set, so it must not truncate the count's scope.
    if (tierFiltered) {
      const rows = await db
        .select({ id: question.id, source: question.source, metadata: question.metadata })
        .from(question)
        .where(and(...filters));
      const ids = rows
        .filter((row) => params.sourceTier?.includes(deriveSourceTier(row).tier))
        .map((row) => row.id);
      filters.push(
        sql`${question.id} in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`,
      );
    }
    const servingSet = await questionServingSet(db, filters);
    servingCounts = await countQuestionServing(db, servingSet);
    if (params.notServable) {
      filters.push(
        sql`${question.id} in (select id from (${servingSet}) serving where not servable)`,
      );
    }
  }

  if (!params.groupByFamily && (!tierFiltered || needServingPass) && !tierSorted) {
    const result = await flatListSqlPaginated(db, filters, params, computedAtSec);
    return servingCounts == null ? result : { ...result, serving_counts: servingCounts };
  }

  const { rows, truncated } = await fetchCandidates(db, filters, needServingPass);
  const derived = rows.map(deriveCandidate);
  let result = params.groupByFamily
    ? aggregateFamilies(derived, params, truncated, computedAtSec)
    : flatList(derived, params, truncated, computedAtSec);
  if (servingCounts != null) result = { ...result, serving_counts: servingCounts };

  // enrich is page-bounded (<=200), so apply it on the in-memory flat page too.
  if (params.enrich && result.families == null && result.items.length > 0) {
    result = {
      ...result,
      items: await enrichItems(db, result.items, params.includeDrafts ?? false),
    };
  }

  const attachTargets =
    result.families != null ? result.families.map((f) => f.representative) : result.items;
  await attachServingToItems(db, attachTargets);
  return result;
}

interface QuestionCursor {
  mode: 'created_at' | 'difficulty';
  direction: QuestionListSortDir;
  createdAt: Date;
  id: string;
  difficulty?: number;
}

function encodeQuestionCursor(
  row: CandidateRow,
  mode: QuestionCursor['mode'],
  direction: QuestionListSortDir,
): string {
  return Buffer.from(
    JSON.stringify({
      mode,
      direction,
      created_at: row.created_at.toISOString(),
      id: row.id,
      ...(mode === 'difficulty' ? { difficulty: row.difficulty } : {}),
    }),
  ).toString('base64url');
}

function decodeQuestionCursor(
  cursor: string,
  mode: QuestionCursor['mode'],
  direction: QuestionListSortDir,
): QuestionCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      mode?: unknown;
      direction?: unknown;
      created_at?: unknown;
      id?: unknown;
      difficulty?: unknown;
    };
    if (
      parsed.mode !== mode ||
      parsed.direction !== direction ||
      typeof parsed.created_at !== 'string' ||
      typeof parsed.id !== 'string' ||
      (mode === 'difficulty' && typeof parsed.difficulty !== 'number')
    ) {
      throw new Error('cursor does not match the requested sort');
    }
    const createdAt = new Date(parsed.created_at);
    if (Number.isNaN(createdAt.getTime())) throw new Error('invalid created_at');
    return {
      mode,
      direction,
      createdAt,
      id: parsed.id,
      ...(mode === 'difficulty' ? { difficulty: parsed.difficulty as number } : {}),
    };
  } catch (err) {
    throw new ApiError('invalid_cursor', `invalid question cursor: ${(err as Error).message}`, 400);
  }
}

function questionCursorFilter(cursor: QuestionCursor): SQL {
  const createdTie = or(
    lt(question.created_at, cursor.createdAt),
    and(eq(question.created_at, cursor.createdAt), lt(question.id, cursor.id)),
  ) as SQL;
  if (cursor.mode === 'difficulty') {
    const difficulty = cursor.difficulty as number;
    return (
      cursor.direction === 'asc'
        ? or(
            gt(question.difficulty, difficulty),
            and(eq(question.difficulty, difficulty), createdTie),
          )
        : or(
            lt(question.difficulty, difficulty),
            and(eq(question.difficulty, difficulty), createdTie),
          )
    ) as SQL;
  }
  if (cursor.direction === 'asc') {
    return or(
      gt(question.created_at, cursor.createdAt),
      and(eq(question.created_at, cursor.createdAt), gt(question.id, cursor.id)),
    ) as SQL;
  }
  return createdTie;
}

// Plain default list: SQL-paginated created_at DESC. Tier is still derived per
// returned row, but no full hit set is needed because no tier filter/sort is
// requested. `truncated` is always false on this path.
async function flatListSqlPaginated(
  db: Db | Tx,
  filters: SQL[],
  params: ListQuestionsParams,
  computedAtSec: number,
): Promise<ListQuestionsResult> {
  const direction = params.sortDir === 'asc' ? asc : desc;
  const cursorDirection = params.sortDir === 'asc' ? 'asc' : 'desc';
  const cursorMode = params.sortBy === 'difficulty' ? 'difficulty' : 'created_at';
  const cursor = params.cursor
    ? decodeQuestionCursor(params.cursor, cursorMode, cursorDirection)
    : null;
  const cursorFilter = cursor ? questionCursorFilter(cursor) : null;
  const whereParts = cursorFilter ? [...filters, cursorFilter] : filters;
  const where = whereParts.length > 0 ? and(...whereParts) : undefined;
  const orderBy =
    params.sortBy === 'difficulty'
      ? [direction(question.difficulty), desc(question.created_at), desc(question.id)]
      : [direction(question.created_at), direction(question.id)];

  const fetchedRows = (await db
    .select(CANDIDATE_COLUMNS)
    .from(question)
    .orderBy(...orderBy)
    .where(where)
    .limit(params.limit + 1)
    .offset(params.cursor ? 0 : params.offset)) as CandidateRow[];

  const hasMore = fetchedRows.length > params.limit;
  const rows = hasMore ? fetchedRows.slice(0, params.limit) : fetchedRows;
  const nextCursor =
    hasMore && !params.notServable && !params.includeServingCounts
      ? encodeQuestionCursor(rows[rows.length - 1], cursorMode, cursorDirection)
      : null;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(question)
    .where(filters.length > 0 ? and(...filters) : undefined);

  let items = rows.map((row) => toListItem(deriveCandidate(row)));
  // Bank-UI enrichment, page-bounded (<=200 rows); never used on tier/family paths.
  if (params.enrich) items = await enrichItems(db, items, params.includeDrafts ?? false);
  // Serving projection for page items and any enriched children.
  await attachServingToItems(db, items);

  return {
    items,
    families: null,
    total: count,
    truncated: false,
    page: pageInfo(count, items.length, params, nextCursor, hasMore),
    computed_at_sec: computedAtSec,
  };
}

// Page-bounded enrichment (<=200 rows), three batched steps to avoid N+1:
// children, subjects, knowledge labels. Children get subjects/labels but are not
// recursed into.
async function enrichItems(
  db: Db | Tx,
  items: QuestionListItem[],
  includeDrafts: boolean,
): Promise<QuestionListItem[]> {
  if (items.length === 0) return items;

  // 1. All question_part children for this page in one IN query.
  const parentIds = items.map((it) => it.id);
  const draftFilter = includeDrafts ? undefined : notDraftPredicate(question.draft_status);
  const childRows = (await db
    .select(CANDIDATE_COLUMNS)
    .from(question)
    .where(
      draftFilter
        ? and(inArray(question.parent_question_id, parentIds), draftFilter)
        : inArray(question.parent_question_id, parentIds),
    )
    .orderBy(
      asc(question.parent_question_id),
      asc(question.part_index),
      asc(question.id),
    )) as CandidateRow[];

  const childrenByParent = new Map<string, QuestionListItem[]>();
  for (const row of childRows) {
    const child = toListItem(deriveCandidate(row));
    const bucket = childrenByParent.get(row.parent_question_id as string);
    if (bucket) bucket.push(child);
    else childrenByParent.set(row.parent_question_id as string, [child]);
  }

  // Enrich page items and child instances together; children are written in place.
  const enrichTargets: QuestionListItem[] = [...items, ...[...childrenByParent.values()].flat()];

  // 2. Learner display subject: registered domain -> canonical id; a real unknown
  //    domain -> raw key; no signal -> null. Scheduling keeps its general fallback;
  //    this read surface must not disguise an unknown subject as general.
  const subjectById = await batchResolveSubjectDisplayIds(
    db,
    enrichTargets.map((it) => ({ id: it.id, knowledge_ids: it.knowledge_ids })),
  );

  // 3. Non-archived knowledge names; archived or missing ids drop out.
  const allKnowledgeIds = [...new Set(enrichTargets.flatMap((it) => it.knowledge_ids))];
  const labelRows =
    allKnowledgeIds.length === 0
      ? []
      : await db
          .select({ id: knowledge.id, name: knowledge.name })
          .from(knowledge)
          .where(and(inArray(knowledge.id, allKnowledgeIds), isNull(knowledge.archived_at)));
  const nameById = new Map(labelRows.map((r) => [r.id, r.name]));
  const labelsFor = (ids: string[]) =>
    ids.filter((id) => nameById.has(id)).map((id) => ({ id, name: nameById.get(id) as string }));

  // Write subject and labels in place for page items and children.
  for (const it of enrichTargets) {
    it.subject = subjectById.get(it.id) ?? null;
    it.notation = resolveSubjectRenderNotation(it.subject);
    it.knowledge_labels = labelsFor(it.knowledge_ids);
  }

  // Attach children and the composite flag on top-level items.
  for (const it of items) {
    const kids = childrenByParent.get(it.id) ?? [];
    it.children = kids;
    it.is_composite = kids.length > 0;
  }
  return items;
}

// Flat list with optional tier filter and tier/created_at sort.
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

  // Base order from SQL is created_at ASC, the stable comparator base.
  if (params.sortBy === 'source_tier') {
    // High tier first plus the demotion rule; equal keys keep the created_at-asc base.
    filtered = [...filtered].sort((a, b) =>
      compareBySourceTierThenWhitelist(
        { tier: a.tier, whitelistMatch: a.whitelistMatch },
        { tier: b.tier, whitelistMatch: b.whitelistMatch },
      ),
    );
  } else {
    // Default list is newest-first; the ascending SQL base exists only for the
    // comparator, so reverse it here.
    filtered = [...filtered].reverse();
  }

  const total = filtered.length;
  const page = filtered.slice(params.offset, params.offset + params.limit);
  return {
    items: page.map(toListItem),
    families: null,
    total,
    truncated,
    page: pageInfo(total, page.length, params),
    computed_at_sec: computedAtSec,
  };
}

// Family aggregation.
function familyKey(c: DerivedCandidate): string {
  // A root's own root_question_id is null, so key it by its id.
  return c.row.root_question_id ?? c.row.id;
}

function aggregateFamilies(
  derived: DerivedCandidate[],
  params: ListQuestionsParams,
  truncated: boolean,
  computedAtSec: number,
): ListQuestionsResult {
  // Tier filtering applies before grouping, mirroring the flat-list order.
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
    // representative = shallowest member (root has depth 0); ties keep the
    // created_at-asc bucket order.
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

  // Newest-first by representative, mirroring the flat list default.
  families.sort((a, b) => b.representative.created_at_sec - a.representative.created_at_sec);

  const total = families.length;
  const page = families.slice(params.offset, params.offset + params.limit);
  return {
    items: [],
    families: page,
    total,
    truncated,
    page: pageInfo(total, page.length, params),
    computed_at_sec: computedAtSec,
  };
}

// Expand one root's full family.
async function expandRootFamily(
  db: Db | Tx,
  params: ListQuestionsParams,
  computedAtSec: number,
): Promise<ListQuestionsResult> {
  const rootKey = params.expandRoot as string;
  const members = await loadFamilyMembers(db, rootKey, !params.includeDrafts);
  const needServingPass = params.notServable === true || params.includeServingCounts === true;
  if (members.length === 0)
    return {
      ...emptyResult(params),
      computed_at_sec: computedAtSec,
      ...(needServingPass
        ? { serving_counts: { not_servable_total: 0, by_reason: {}, legacy_unpublished: 0 } }
        : {}),
    };

  let derived = members.map(deriveCandidate);
  let servingCounts: ServingCounts | undefined;
  if (needServingPass) {
    const ids = JSON.stringify(members.map((row) => row.id));
    const servingSet = await questionServingSet(db, [
      sql`${question.id} in (select jsonb_array_elements_text(${ids}::jsonb))`,
    ]);
    servingCounts = await countQuestionServing(db, servingSet);
    if (params.notServable) {
      const held = await db.execute<{ id: string }>(sql`
        select id from (${servingSet}) serving where not servable
      `);
      const heldIds = new Set(held.map((row) => row.id));
      derived = derived.filter((c) => heldIds.has(c.row.id));
    }
  }

  // Depth asc, then created_at asc: the family-tree reading order.
  derived.sort((a, b) => {
    if (a.row.variant_depth !== b.row.variant_depth) {
      return a.row.variant_depth - b.row.variant_depth;
    }
    return a.row.created_at.getTime() - b.row.created_at.getTime();
  });

  const total = derived.length;
  const page = derived.slice(params.offset, params.offset + params.limit);
  const items = page.map(toListItem);
  await attachServingToItems(db, items);
  return {
    items,
    families: null,
    total,
    truncated: false,
    ...(servingCounts != null ? { serving_counts: servingCounts } : {}),
    page: pageInfo(total, page.length, params),
    computed_at_sec: computedAtSec,
  };
}

/**
 * Every member of a variant family (the root plus its variants). Membership is
 * root_question_id = rootKey or id = rootKey. excludeDrafts mirrors the list
 * convention; the detail reader passes false because it shows drafts.
 */
export async function loadFamilyMembers(
  db: Db | Tx,
  rootKey: string,
  excludeDrafts: boolean,
): Promise<CandidateRow[]> {
  const membership = sql`(${question.root_question_id} = ${rootKey} OR ${question.id} = ${rootKey})`;
  const bankVisible = ne(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE);
  const where = excludeDrafts
    ? and(membership, bankVisible, notDraftPredicate(question.draft_status))
    : and(membership, bankVisible);
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
