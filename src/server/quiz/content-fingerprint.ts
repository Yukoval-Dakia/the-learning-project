import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm';

import { initialFsrsState } from '@/capabilities/practice/server/fsrs';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';
import { enrollFsrsStateIfAbsent } from '@/server/fsrs/state';

// Bumping this version rewrites the canonical string, so every persisted
// `canonical_content_hash` computed under the old version becomes stale and
// old-vs-new duplicate detection silently stops matching. Migration 0067 does no
// backfill, so a version bump MUST be paired with a recompute/backfill plan.
export const CANONICAL_QUESTION_CONTENT_VERSION = 1 as const;

export interface CanonicalQuestionContentInput {
  promptMd: string;
  referenceMd?: string | null;
  choicesMd?: string[] | null;
  rubricJson?: unknown;
  // Callers may carry provenance envelopes. Identity intentionally reads only the fields above.
  [key: string]: unknown;
}

function normalizeMarkdown(value: string): string {
  return (
    value
      .normalize('NFKC')
      .replace(/\r\n?/g, '\n')
      // Keep image presence + alt semantics while excluding unstable transport URLs.
      .replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, (_match, alt: string) => {
        return `![${alt.trim()}](IMAGE)`;
      })
      // NOTE: underscore-emphasis is deliberately NOT canonicalized. A `_x_`→`*x*` (or `__x__`→`**x**`)
      // rewrite corrupts LaTeX subscripts, which are pervasive in math/physics content: e.g. the real
      // reference answer `$x_1 = 2$，$x_2 = 3$` (src/subjects/math/skills/quiz-gen-calculation/assets/
      // few-shot.json) has the span `_1 = 2$，$x_` rewritten to `*1 = 2$，$x*`, which both mangles the
      // canonical string and collides a genuine subscript with the asterisk emphasis form. Identity
      // safety beats emphasis-equivalence here, so underscore forms are left verbatim. Asterisk forms
      // (`**bold**` / `*italic*`) are already canonical and pass through untouched.
      .replace(/[\t\n\f\r ]+/g, ' ')
      .trim()
  );
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      // Code-unit ordering, NOT localeCompare: locale/ICU-dependent collation would
      // make the canonical hash (a UNIQUE partial index key) non-deterministic across
      // runtimes, breaking dedup and risking spurious unique-constraint violations.
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, stableJson(child)]),
    );
  }
  // Rubric JSON carries exact-match tokens (keywords, acceptable_answers,
  // final_answer, answer_equivalents, expected_signals). The Markdown pipeline
  // (emphasis rewrite, image stripping, whitespace collapse) would corrupt those,
  // so canonicalize arbitrary JSON strings with Unicode NFKC only.
  return typeof value === 'string' ? value.normalize('NFKC') : value;
}

export function canonicalQuestionContent(input: CanonicalQuestionContentInput): string {
  return JSON.stringify({
    version: CANONICAL_QUESTION_CONTENT_VERSION,
    prompt: normalizeMarkdown(input.promptMd),
    answer: input.referenceMd == null ? null : normalizeMarkdown(input.referenceMd),
    choices: input.choicesMd?.map(normalizeMarkdown) ?? null,
    rubric: input.rubricJson == null ? null : stableJson(input.rubricJson),
  });
}

/** Exact identity SHA-256. This is not the embedding freshness hash. */
export function canonicalQuestionContentHash(input: CanonicalQuestionContentInput): string {
  return createHash('sha256').update(canonicalQuestionContent(input)).digest('hex');
}

export interface ExactQuestionDuplicate {
  id: string;
  draftStatus: string | null;
  source: string;
}

export interface ExactQuestionDuplicateKnowledgeMerge extends ExactQuestionDuplicate {
  disposition: 'merged' | 'released_terminal_draft';
  previousKnowledgeIds: string[];
  knowledgeIds: string[];
  addedKnowledgeIds: string[];
  enrolledKnowledgeIds: string[];
  previousVersion: number;
  version: number;
  eventId: string | null;
}

/**
 * Keep the current supply target first, then retain any additional model attribution in its own
 * order. Several review/calibration readers treat knowledge_ids[0] as the primary family anchor;
 * a question generated to fill target K1 must therefore not become primarily K2 merely because
 * the model returned K2 explicitly.
 */
export function combineExactDuplicateKnowledgeIds(
  questionKnowledgeIds: string[],
  targetKnowledgeIds: string[],
): string[] {
  return [...new Set([...targetKnowledgeIds, ...questionKnowledgeIds])];
}

/**
 * Cap on how many exact-duplicate records a producer serializes into its observability event.
 * The full count is kept separately (`exact_duplicate_count`); this only bounds the sampled detail
 * list so a batch with many duplicates cannot bloat the immutable event payload.
 */
export const EXACT_DUPLICATE_EVENT_SAMPLE_CAP = 20;

/** Reusable active+draft lookup; legacy NULL-hash rows intentionally do not match. */
export async function findExactQuestionDuplicate(
  db: Db | Tx,
  hash: string,
): Promise<ExactQuestionDuplicate | null> {
  const rows = await db
    .select({ id: question.id, draftStatus: question.draft_status, source: question.source })
    .from(question)
    .where(eq(question.canonical_content_hash, hash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Reconcile a canonical duplicate with the knowledge attribution requested by the current supply
 * run. The existing question remains the single global content identity; missing KCs are appended
 * in request order under a row lock, with a normal question-edit audit event + version bump.
 *
 * Lifecycle is deliberately preserved. An active duplicate stays active and each newly-attributed
 * live KC is FSRS-enrolled-if-absent in the same transaction. A pending draft stays in its original
 * route's verification flow. A terminal rejected/needs-review draft cannot be re-dispatched because
 * verifier events are append-only idempotency guards, so it releases the canonical hash and lets the
 * current producer persist a fresh candidate instead of falsely closing the target KC's supply gap.
 * No-op when the duplicate already covers every requested live KC.
 *
 * Must run inside the producer's transaction so lookup, merge, and any competing canonical-hash
 * INSERT are serialized as one persistence decision.
 */
export async function mergeExactQuestionDuplicateKnowledgeIds(
  tx: Tx,
  params: {
    canonicalContentHash: string;
    knowledgeIds: string[];
    // YUK-697: jyeoo_fetch reuses this cross-KC dedup path via insertSourcedDraft.
    actorRef: 'quiz_gen' | 'sourcing' | 'jyeoo_fetch';
    taskRunId?: string;
    now: Date;
  },
): Promise<ExactQuestionDuplicateKnowledgeMerge | null> {
  // YUK-497 review F2 (revised after the barrier-test deadlock postmortem) — lock order
  // must be G→question-row (matching the live submit tx), but taking G on the LOOKUP-MISS
  // path serializes the producers' entire persist txs and deadlocks the designed
  // canonical-hash race choreography (a tx holding G at the post-miss seam while its racing
  // twin blocks on G). So: optimistic UNLOCKED peek first — a miss returns null having
  // taken NO locks (the miss path is safe without them: the caller's INSERT is guarded by
  // onConflictDoNothing on the canonical hash, and the conflict loser re-enters here and
  // merges under the locks). Only a HIT acquires G and then re-reads FOR UPDATE, so every
  // path that touches the row or reaches enrollFsrsStateIfAbsent holds G first.
  const peek = await tx
    .select({ id: question.id })
    .from(question)
    .where(eq(question.canonical_content_hash, params.canonicalContentHash))
    .limit(1);
  if (peek.length === 0) return null;

  await acquireLearningStateWriteLock(tx);
  const rows = await tx
    .select({
      id: question.id,
      draftStatus: question.draft_status,
      source: question.source,
      knowledgeIds: question.knowledge_ids,
      metadata: question.metadata,
      version: question.version,
    })
    .from(question)
    .where(eq(question.canonical_content_hash, params.canonicalContentHash))
    .limit(1)
    .for('update');
  const row = rows[0];
  // The peeked row can vanish between the unlocked peek and the locked re-read only via
  // out-of-band deletion (question rows are never deleted by production flows); treat as
  // a clean miss rather than inventing a row.
  if (!row) return null;

  const terminalVerifyAction =
    row.source === 'quiz_gen'
      ? 'experimental:quiz_verify'
      : row.source === 'web_sourced'
        ? 'experimental:source_verify'
        : null;
  if (row.draftStatus === 'draft' && terminalVerifyAction) {
    const terminal = await tx
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, terminalVerifyAction),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, row.id),
          or(isNull(event.outcome), ne(event.outcome, 'error')),
        ),
      )
      .limit(1);
    if (terminal.length > 0) {
      const nextVersion = row.version + 1;
      const eventId = createId();
      const archivedAt = Math.floor(params.now.getTime() / 1000);
      await tx
        .update(question)
        .set({
          canonical_content_hash: null,
          metadata: {
            ...(row.metadata ?? {}),
            archived_at: archivedAt,
            archived_reason: 'terminal_draft_superseded_by_reproduction',
            archived_previous_draft_status: row.draftStatus,
          },
          updated_at: params.now,
          version: nextVersion,
        })
        .where(
          and(
            eq(question.id, row.id),
            eq(question.canonical_content_hash, params.canonicalContentHash),
          ),
        );
      await writeEvent(tx, {
        id: eventId,
        session_id: null,
        actor_kind: 'agent',
        actor_ref: params.actorRef,
        action: 'experimental:question_edit',
        subject_kind: 'question',
        subject_id: row.id,
        outcome: 'success',
        payload: {
          question_id: row.id,
          previous_version: row.version,
          next_version: nextVersion,
          before: {
            canonical_content_hash: params.canonicalContentHash,
            archived_at: null,
          },
          after: { canonical_content_hash: null, archived_at: archivedAt },
          reason: 'terminal_draft_superseded_for_reproduction',
          terminal_verify_event_id: terminal[0].id,
          task_run_id: params.taskRunId ?? null,
          preserved_draft_status: row.draftStatus,
        },
        created_at: params.now,
      });
      return {
        ...row,
        disposition: 'released_terminal_draft',
        previousKnowledgeIds: row.knowledgeIds,
        knowledgeIds: row.knowledgeIds,
        addedKnowledgeIds: [],
        enrolledKnowledgeIds: [],
        previousVersion: row.version,
        version: nextVersion,
        eventId,
      };
    }
  }

  const requestedKnowledgeIds = [
    ...new Set(params.knowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  ];
  const liveKnowledgeRows =
    requestedKnowledgeIds.length > 0
      ? await tx
          .select({ id: knowledge.id })
          .from(knowledge)
          .where(and(inArray(knowledge.id, requestedKnowledgeIds), isNull(knowledge.archived_at)))
          .orderBy(knowledge.id)
          .for('update')
      : [];
  const liveKnowledgeIds = new Set(liveKnowledgeRows.map((candidate) => candidate.id));

  const seen = new Set(row.knowledgeIds);
  const addedKnowledgeIds: string[] = [];
  for (const id of requestedKnowledgeIds) {
    if (!liveKnowledgeIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    addedKnowledgeIds.push(id);
  }
  const knowledgeIds = [...row.knowledgeIds, ...addedKnowledgeIds];
  if (addedKnowledgeIds.length === 0) {
    return {
      ...row,
      disposition: 'merged',
      previousKnowledgeIds: row.knowledgeIds,
      knowledgeIds,
      addedKnowledgeIds,
      enrolledKnowledgeIds: [],
      previousVersion: row.version,
      eventId: null,
    };
  }

  const nextVersion = row.version + 1;
  const updated = await tx
    .update(question)
    .set({ knowledge_ids: knowledgeIds, updated_at: params.now, version: nextVersion })
    .where(
      and(
        eq(question.id, row.id),
        eq(question.canonical_content_hash, params.canonicalContentHash),
      ),
    )
    .returning({ id: question.id });
  if (updated.length === 0) {
    throw new Error(`canonical duplicate ${row.id} changed while merging knowledge attribution`);
  }

  const eventId = createId();
  const enrolledKnowledgeIds: string[] = [];
  if (row.draftStatus !== 'draft') {
    const initial = initialFsrsState(params.now);
    for (const knowledgeId of addedKnowledgeIds) {
      const enrolled = await enrollFsrsStateIfAbsent(tx, {
        subject_kind: 'knowledge',
        subject_id: knowledgeId,
        state: initial.state,
        due_at: initial.dueAt,
        last_review_event_id: eventId,
      });
      if (enrolled) enrolledKnowledgeIds.push(knowledgeId);
    }
  }
  await writeEvent(tx, {
    id: eventId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: params.actorRef,
    action: 'experimental:question_edit',
    subject_kind: 'question',
    subject_id: row.id,
    outcome: 'success',
    payload: {
      question_id: row.id,
      previous_version: row.version,
      next_version: nextVersion,
      before: { knowledge_ids: row.knowledgeIds },
      after: { knowledge_ids: knowledgeIds },
      reason: 'cross_kc_exact_duplicate',
      canonical_content_hash: params.canonicalContentHash,
      added_knowledge_ids: addedKnowledgeIds,
      enrolled_knowledge_ids: enrolledKnowledgeIds,
      task_run_id: params.taskRunId ?? null,
      preserved_draft_status: row.draftStatus,
    },
    created_at: params.now,
  });

  return {
    ...row,
    disposition: 'merged',
    previousKnowledgeIds: row.knowledgeIds,
    knowledgeIds,
    addedKnowledgeIds,
    enrolledKnowledgeIds,
    previousVersion: row.version,
    version: nextVersion,
    eventId,
  };
}
