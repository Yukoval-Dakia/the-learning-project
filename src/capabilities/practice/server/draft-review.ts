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

import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';

type DbLike = Db | Tx;

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
  verify_status: DraftVerifyStatus;
  /** model's驳回理由 (summary_md) when the latest terminal verify did not promote. */
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
function deriveVerifyVerdict(
  payload: Record<string, unknown> | null,
  outcome: string | null,
): { status: 'needs_review' | 'failed'; reason: string | null } {
  const verificationStatus = payload?.verification_status;
  const overall = payload?.overall;
  let status: 'needs_review' | 'failed';
  if (verificationStatus === 'needs_review' || overall === 'needs_review') {
    status = 'needs_review';
  } else if (verificationStatus === 'failed' || overall === 'fail') {
    status = 'failed';
  } else {
    // source_verify (tier-2) carries no verification_status/overall; a terminal
    // non-promoted event ⇒ failed. outcome='partial' (no verdict field) ⇒ needs_review.
    status = outcome === 'partial' ? 'needs_review' : 'failed';
  }
  const summary = payload?.summary_md;
  return {
    status,
    reason: typeof summary === 'string' && summary.length > 0 ? summary : null,
  };
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

  return {
    rows: rows.map((r): DraftReviewRow => {
      const verdict = verdictById.get(r.id);
      return {
        id: r.id,
        prompt_preview: truncatePrompt(r.prompt_md),
        kind: r.kind,
        source: r.source,
        created_at: r.created_at,
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
