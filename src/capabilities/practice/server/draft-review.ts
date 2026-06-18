// YUK-402 inc-4a — owner manual gate: draft-review pool projection.
//
// docs/superpowers/specs/2026-06-18-inc4-owner-manual-gate-design.md §2.
//
// The owner manual gate审核面 lists the draft slices of the `question` table
// (draft_status='draft') so the owner can enable / force-enable each one. This
// module owns the read projection (the route is a thin shell over it, mirroring
// the observability capability's server/ai-observability.ts split):
//   - SELECT draft_status='draft' rows, EXCLUDING soft-archived drafts. A
//     soft-archived (deleted) question is re-drafted with metadata.archived_at set
//     (src/server/questions/write.ts archiveQuestion); those are NOT pending-review
//     drafts and must not appear in the review pool.
//   - For each draft, derive a verify status from the LATEST TERMINAL verify event
//     (action ∈ {experimental:quiz_verify, experimental:source_verify}, subject_kind
//     ='question', outcome != 'error' — the catch-bottom writes outcome='error' for
//     a transient/system failure that has no verdict, so it must be ignored). The
//     verdict lives in the event payload:
//       quiz_verify  → payload.verification_status ('needs_review' | 'failed')
//       source_verify→ tier-2 has no verification_status; a non-promoted terminal
//                      event (outcome='failure') ⇒ 'failed'.
//     No terminal event ⇒ 'unverified' (未验过 raw draft).
//   - reason: payload.summary_md when present (the model's驳回理由), else null.

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';

type DbLike = Db | Tx;

/** A knowledge concept tag on a draft: id + display label (knowledge.name). */
export interface DraftKnowledgeRef {
  id: string;
  label: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PROMPT_PREVIEW_LENGTH = 160;

const VERIFY_ACTIONS = ['experimental:quiz_verify', 'experimental:source_verify'] as const;

export type DraftVerifyStatus = 'unverified' | 'needs_review' | 'failed';

export interface DraftReviewRow {
  id: string;
  prompt_preview: string;
  kind: string;
  source: string;
  created_at: Date;
  /** question.difficulty (1–5) — renders the难度 pips in the preview meta. */
  difficulty: number;
  /** resolved knowledge tags (id → knowledge.name label). */
  knowledge: DraftKnowledgeRef[];
  verify_status: DraftVerifyStatus;
  /** model's驳回理由 (summary_md) when the latest terminal verify did not promote. */
  verify_reason: string | null;
}

/**
 * Full-text draft projection for the single-draft preview pane (inc-4b). Unlike
 * the list row this carries the UNtruncated prompt + the option/answer/passage
 * blocks the loom DrPreviewBody needs.
 */
export interface DraftReviewDetail {
  id: string;
  kind: string;
  source: string;
  created_at: Date;
  difficulty: number;
  knowledge: DraftKnowledgeRef[];
  /** full prompt_md (NOT the 160-char list preview). */
  prompt_md: string;
  /** reading material / passage — derived from a stem structured tree, else null. */
  passage: string | null;
  /** mcq choices (choices_md) when present, else null. */
  options: string[] | null;
  /** reference answer (reference_md) when present, else null. */
  answer: string | null;
  verify_status: DraftVerifyStatus;
  verify_reason: string | null;
}

export interface DraftReviewListOpts {
  source?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}

export interface DraftReviewListPage {
  rows: DraftReviewRow[];
  limit: number;
  offset: number;
  total: number;
  truncated: boolean;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(limit), MAX_LIMIT);
}

function truncatePrompt(prompt: string): string {
  if (prompt.length <= PROMPT_PREVIEW_LENGTH) return prompt;
  return `${prompt.slice(0, PROMPT_PREVIEW_LENGTH)}…`;
}

// Map the latest terminal verify event payload → a draft verify status + reason.
// A draft sitting in the pool was, by definition, NOT promoted, so the terminal
// verdict is only ever needs_review | failed (a 'pass'/promote would have moved the
// row to active and out of this list).
//
// YUK-350 (B5 increment C) — all three promote-gated handlers (quiz/source/variant)
// now emit the unified verify contract shape ({ axes, overall, failure_class?,
// summary_md, confidence }) as a SUPERSET of their prior payloads. This reader prefers
// the unified `overall` (now present on source_verify too — it previously had none,
// which is why the legacy `outcome`-fallback branch below existed) and falls back to
// the still-emitted `verification_status` (quiz) and the `outcome` heuristic for any
// older / pre-contract event already in the table.
function deriveVerifyVerdict(
  payload: Record<string, unknown> | null,
  outcome: string | null,
): { status: 'needs_review' | 'failed'; reason: string | null } {
  const verificationStatus = payload?.verification_status;
  // unified contract overall (4-value pass|needs_review|fail|error). A draft in the pool
  // was never promoted, so 'pass'/'error' never reach here (pass would have left the
  // pool; outcome='error' events are excluded by the query's ne(outcome,'error')).
  const overall = payload?.overall;
  let status: 'needs_review' | 'failed';
  if (verificationStatus === 'needs_review' || overall === 'needs_review') {
    status = 'needs_review';
  } else if (verificationStatus === 'failed' || overall === 'fail') {
    status = 'failed';
  } else {
    // Pre-contract source_verify (tier-2) carried no verification_status/overall; a
    // terminal non-promoted event ⇒ failed. outcome='partial' (no verdict field) ⇒
    // needs_review. (Post-contract source_verify now carries `overall`, handled above.)
    status = outcome === 'partial' ? 'needs_review' : 'failed';
  }
  const summary = payload?.summary_md;
  return {
    status,
    reason: typeof summary === 'string' && summary.length > 0 ? summary : null,
  };
}

// Resolve a set of knowledge ids → {id,label} in one round-trip (avoid N+1).
// Preserves the per-question ORDER of knowledge_ids; an id with no row falls
// back to the id itself as the label so the preview never shows a blank tag.
// (No archived_at filter — an archived KC still resolves to its name here, which
// is acceptable for a draft preview tag.)
async function resolveKnowledgeLabels(db: DbLike, ids: string[]): Promise<Map<string, string>> {
  const labelById = new Map<string, string>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return labelById;
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(inArray(knowledge.id, unique));
  for (const r of rows) labelById.set(r.id, r.name);
  return labelById;
}

function toKnowledgeRefs(ids: string[], labelById: Map<string, string>): DraftKnowledgeRef[] {
  return ids.map((id) => ({ id, label: labelById.get(id) ?? id }));
}

// Derive the reading material / passage for the preview. A passage lives in the
// `structured` tree as the stem node's prompt_text (role='stem' with sub_questions);
// plain/standalone questions have no separate passage block → null.
function derivePassage(structured: StructuredQuestionT | null | undefined): string | null {
  if (!structured) return null;
  if (
    structured.role === 'stem' &&
    structured.sub_questions &&
    structured.sub_questions.length > 0 &&
    typeof structured.prompt_text === 'string' &&
    structured.prompt_text.length > 0
  ) {
    return structured.prompt_text;
  }
  return null;
}

/**
 * List the draft-review pool (draft_status='draft', excluding soft-archived
 * drafts), with per-draft verify status derived from the latest terminal verify
 * event. Paginated; optional source/kind filter.
 */
export async function listDraftReview(
  db: DbLike,
  opts: DraftReviewListOpts,
): Promise<DraftReviewListPage> {
  const limit = normalizeLimit(opts.limit);
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));

  const conditions = [
    eq(question.draft_status, 'draft'),
    // exclude soft-archived (deleted) drafts: metadata.archived_at IS NULL/absent.
    sql`(${question.metadata} -> 'archived_at') IS NULL`,
  ];
  if (opts.source) conditions.push(eq(question.source, opts.source));
  if (opts.kind) conditions.push(eq(question.kind, opts.kind));
  const where = and(...conditions);

  const rows = await db
    .select({
      id: question.id,
      prompt_md: question.prompt_md,
      kind: question.kind,
      source: question.source,
      difficulty: question.difficulty,
      knowledge_ids: question.knowledge_ids,
      created_at: question.created_at,
    })
    .from(question)
    .where(where)
    .orderBy(desc(question.created_at), desc(question.id))
    .limit(limit)
    .offset(offset);

  const totalRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(question)
    .where(where);
  const total = totalRows[0]?.count ?? 0;

  // Fetch the latest TERMINAL (outcome != 'error') verify event per draft in one
  // round-trip; pick the newest by created_at in memory.
  const ids = rows.map((r) => r.id);
  const verdictById = new Map<
    string,
    { status: 'needs_review' | 'failed'; reason: string | null }
  >();
  if (ids.length > 0) {
    const verifyEvents = await db
      .select({
        subject_id: event.subject_id,
        outcome: event.outcome,
        payload: event.payload,
        created_at: event.created_at,
      })
      .from(event)
      .where(
        and(
          inArray(event.action, [...VERIFY_ACTIONS]),
          eq(event.subject_kind, 'question'),
          inArray(event.subject_id, ids),
          ne(event.outcome, 'error'),
        ),
      )
      .orderBy(desc(event.created_at), desc(event.id));
    // first row per subject_id is the newest (desc order) → keep it.
    for (const ev of verifyEvents) {
      if (verdictById.has(ev.subject_id)) continue;
      verdictById.set(
        ev.subject_id,
        deriveVerifyVerdict(ev.payload as Record<string, unknown> | null, ev.outcome),
      );
    }
  }

  // Resolve every KC referenced on this page → label, in one round-trip.
  const labelById = await resolveKnowledgeLabels(
    db,
    rows.flatMap((r) => r.knowledge_ids),
  );

  return {
    rows: rows.map((r): DraftReviewRow => {
      const verdict = verdictById.get(r.id);
      return {
        id: r.id,
        prompt_preview: truncatePrompt(r.prompt_md),
        kind: r.kind,
        source: r.source,
        created_at: r.created_at,
        difficulty: r.difficulty,
        knowledge: toKnowledgeRefs(r.knowledge_ids, labelById),
        verify_status: verdict?.status ?? 'unverified',
        verify_reason: verdict?.reason ?? null,
      };
    }),
    limit,
    offset,
    total,
    truncated: total > offset + rows.length,
  };
}

/**
 * Full-text projection for a single draft (the preview pane, inc-4b). Serves only
 * draft_status='draft' AND non-soft-archived questions (same filter as the list);
 * a non-draft / soft-archived / missing question returns null (the route maps that
 * to 404). Reuses the list's verify-status derivation (latest terminal event).
 */
export async function getDraftReviewDetail(
  db: DbLike,
  id: string,
): Promise<DraftReviewDetail | null> {
  const rows = await db
    .select({
      id: question.id,
      kind: question.kind,
      source: question.source,
      difficulty: question.difficulty,
      knowledge_ids: question.knowledge_ids,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      choices_md: question.choices_md,
      structured: question.structured,
      created_at: question.created_at,
    })
    .from(question)
    .where(
      and(
        eq(question.id, id),
        eq(question.draft_status, 'draft'),
        // exclude soft-archived (deleted) drafts (mirror the list filter).
        sql`(${question.metadata} -> 'archived_at') IS NULL`,
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Latest terminal verify verdict (same derivation as the list).
  const verifyEvents = await db
    .select({
      outcome: event.outcome,
      payload: event.payload,
    })
    .from(event)
    .where(
      and(
        inArray(event.action, [...VERIFY_ACTIONS]),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, id),
        ne(event.outcome, 'error'),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  const verdict = verifyEvents[0]
    ? deriveVerifyVerdict(
        verifyEvents[0].payload as Record<string, unknown> | null,
        verifyEvents[0].outcome,
      )
    : null;

  const labelById = await resolveKnowledgeLabels(db, row.knowledge_ids);
  const choices = row.choices_md as string[] | null;

  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    created_at: row.created_at,
    difficulty: row.difficulty,
    knowledge: toKnowledgeRefs(row.knowledge_ids, labelById),
    prompt_md: row.prompt_md,
    passage: derivePassage(row.structured as StructuredQuestionT | null),
    options: choices && choices.length > 0 ? choices : null,
    answer:
      typeof row.reference_md === 'string' && row.reference_md.length > 0 ? row.reference_md : null,
    verify_status: verdict?.status ?? 'unverified',
    verify_reason: verdict?.reason ?? null,
  };
}
