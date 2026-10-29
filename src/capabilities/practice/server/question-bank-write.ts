import { getCurrentFailureAttempts } from '@/kernel/read-models/failure-attempts';
// Question-bank write path: edit (PATCH) + archive (DELETE).
//
// Soft-delete: there is no archived_at column, and every pool/due/practice/review
// consumer already excludes `draft_status='draft'`. Archiving therefore sets that
// value instead of adding an 'archived' status, which the existing `<> 'draft'`
// filters would leak. The archive intent lives in the `experimental:question_archive`
// event and `metadata.archived_at/archived_reason`.
//
// Parts are independent question rows with no FK cascade, so archiving a parent must
// cascade-archive live parts in the same transaction. Variant children are separate
// scheduling entities and are not cascaded. Every edit/archive records before/after
// in an event so changes stay traceable and reversible.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { embedHash, questionEmbedText } from '@/core/embed-source';
import { LEGACY_DRAFT_STATUS } from '@/core/schema/assessment/lifecycle';
import { QUESTION_EDIT_ACTION } from '@/core/schema/event/experimental';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import {
  artifact,
  event,
  material_fsrs_state,
  question,
  question_group_lifecycle,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { assertKnowledgeIdsExist } from '@/kernel/read-models/knowledge-validate';
import { deriveAnswerClassForValues } from '@/kernel/records/answer-class-write';
import {
  archiveGroupLifecycle,
  publishQuestionGroupFromRow,
  restoreGroupLifecycle,
} from '@/kernel/records/assessment-publication';

/** Display label stamped on part rows; part-ness is read from `parent_question_id`. */
export const QUESTION_PART_KIND = 'question_part' as const;

// Bloodline fields are owned by the variant-gen/parts writers and cannot be edited
// through the question-bank PATCH surface; the route rejects them precisely.
export const BLOODLINE_FIELDS = [
  'variant_depth',
  'root_question_id',
  'parent_variant_id',
  'parent_question_id',
  'part_index',
] as const;

export interface QuestionAssociationCounts {
  attempts: number;
  fsrs_cards: number;
  paper_refs: number;
  mistakes: number;
  children: number;
}

/**
 * Count every reference to a question for the DELETE warning. `mistakes` is the
 * failure subset of attempts (the old mistake table is gone). `paper_refs` counts all
 * artifact references, including archived ones, because they would be orphaned.
 * `children` includes drafted parts: the warning describes the full attached structure.
 */
export async function countQuestionAssociations(
  db: Db,
  questionId: string,
): Promise<QuestionAssociationCounts> {
  const [[attemptRow], mistakes, [fsrsRow], [paperRow], [childrenRow]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(event)
      .where(
        and(
          inArray(event.action, ['attempt', 'experimental:assessment_attempt']),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, questionId),
        ),
      ),
    getCurrentFailureAttempts(db, { questionIds: [questionId] }),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'question'),
          eq(material_fsrs_state.subject_id, questionId),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(artifact)
      .where(sql`${artifact.tool_state}->'question_ids' @> ${JSON.stringify([questionId])}::jsonb`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(question)
      .where(eq(question.parent_question_id, questionId)),
  ]);

  return {
    attempts: attemptRow?.n ?? 0,
    mistakes: mistakes.length,
    fsrs_cards: fsrsRow?.n ?? 0,
    paper_refs: paperRow?.n ?? 0,
    children: childrenRow?.n ?? 0,
  };
}

export function hasAnyAssociation(counts: QuestionAssociationCounts): boolean {
  return (
    counts.attempts > 0 ||
    counts.mistakes > 0 ||
    counts.fsrs_cards > 0 ||
    counts.paper_refs > 0 ||
    counts.children > 0
  );
}

// ── Editable surface ─────────────────────────────────────────────────────────
// The route validates the patch (zod over core schema); this applies it.
export interface QuestionEditPatch {
  prompt_md?: string;
  reference_md?: string | null;
  choices_md?: string[] | null;
  difficulty?: number;
  knowledge_ids?: string[];
  kind?: string;
  draft_status?: 'draft' | 'active' | null;
  /**
   * Structured trees are scoring input (they source part/slot/option identity), so
   * edits must republish. REST PATCH does not expose this field yet; the seam keeps
   * internal writers from drifting silently.
   */
  structured?: StructuredQuestionT | null;
}

export interface QuestionEditResult {
  // `noop` = no real change (no version bump or event); `knowledge_invalid` =
  // missing/archived knowledge id; `protected` = product-owned diagnostic content;
  // `composite_lifecycle` = draft_status flip on a composite member, whose lifecycle
  // is owned by the verify cascade/owner override/archiveQuestion.
  status:
    | 'updated'
    | 'noop'
    | 'conflict'
    | 'not_found'
    | 'knowledge_invalid'
    | 'protected'
    | 'composite_lifecycle';
  event_id?: string;
  version?: number;
  missing_knowledge_ids?: string[];
}

// Deep equality for the edit diff. Key-insensitive object comparison keeps a
// semantically identical jsonb round trip from fabricating an audit entry, version
// bump and revision.
function patchValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => patchValueEqual(v, b[i]));
  }
  if (
    a != null &&
    b != null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    // jsonb drops undefined keys, so compare defined keys only.
    const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
    const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((k) => Object.hasOwn(bo, k) && patchValueEqual(ao[k], bo[k]))
    );
  }
  return false;
}

// Scoring-input edits mint a revision; difficulty/knowledge_ids/draft_status are
// projection or lifecycle fields and do not. structured counts because it sources
// part/slot/option identity.
const PUBLISH_TRIGGERING_FIELDS = new Set([
  'prompt_md',
  'reference_md',
  'choices_md',
  'kind',
  'structured',
]);

/**
 * Apply an edit patch with optimistic locking and a before/after audit event in one
 * transaction. Scoring-input changes also mint a revision through the publisher.
 */
export async function editQuestion(
  db: Db,
  questionId: string,
  expectedVersion: number,
  patch: QuestionEditPatch,
  actorRef: string,
): Promise<QuestionEditResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(question).where(eq(question.id, questionId)).limit(1);
    const row = rows[0];
    if (!row) return { status: 'not_found' };
    if (row.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) {
      return { status: 'protected' };
    }

    // A direct draft_status flip would bypass group atomicity: a standalone part
    // could serve under a draft parent, or a re-drafted parent orphan active children.
    // Only a real flip is blocked; other fields remain editable.
    if (patch.draft_status !== undefined && patch.draft_status !== row.draft_status) {
      if (row.parent_question_id != null) return { status: 'composite_lifecycle' };
      const [childRow] = await tx
        .select({ id: question.id })
        .from(question)
        .where(eq(question.parent_question_id, questionId))
        .limit(1);
      if (childRow) return { status: 'composite_lifecycle' };
    }

    // Revalidate in the commit transaction to close the TOCTOU window where a node
    // is archived after the route's friendly pre-check. Empty array means clear all.
    if (patch.knowledge_ids && patch.knowledge_ids.length > 0) {
      // The helper only reads; a tx satisfies the query surface.
      const check = await assertKnowledgeIdsExist(tx, patch.knowledge_ids);
      if (!check.ok) return { status: 'knowledge_invalid', missing_knowledge_ids: check.missing };
    }

    // Track only changed fields so a full-form save does not fabricate audit entries,
    // bump the version, or inflate 409s on no-op edits.
    const now = new Date();
    const setValues: Partial<typeof question.$inferInsert> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    const track = <K extends keyof QuestionEditPatch>(
      key: K,
      column: keyof typeof question.$inferInsert,
      prev: unknown,
    ) => {
      if (patch[key] === undefined) return;
      const next = patch[key];
      if (patchValueEqual(prev, next)) return;
      // biome-ignore lint/suspicious/noExplicitAny: dynamic column assignment over a validated patch.
      (setValues as any)[column] = next;
      before[column as string] = prev;
      after[column as string] = next;
    };

    track('prompt_md', 'prompt_md', row.prompt_md);
    track('reference_md', 'reference_md', row.reference_md);
    track('choices_md', 'choices_md', row.choices_md);
    track('difficulty', 'difficulty', row.difficulty);
    track('knowledge_ids', 'knowledge_ids', row.knowledge_ids);
    track('kind', 'kind', row.kind);
    track('draft_status', 'draft_status', row.draft_status);
    track('structured', 'structured', row.structured);

    // answer_class is derived from kind/choices_md/rubric_json. Re-derive from the
    // merged row when a structural input changes so it cannot go stale. It shadows
    // already-audited fields, so it stays out of before/after; never guess when the
    // row lacks a kind (the backfill net owns that).
    if (Object.hasOwn(after, 'kind') || Object.hasOwn(after, 'choices_md')) {
      const nextKind = patch.kind !== undefined ? patch.kind : row.kind;
      const nextChoices = patch.choices_md !== undefined ? patch.choices_md : row.choices_md;
      const derivedAnswerClass = deriveAnswerClassForValues({
        kind: nextKind,
        choices_md: nextChoices,
        rubric_json: row.rubric_json,
      });
      if (derivedAnswerClass != null) setValues.answer_class = derivedAnswerClass;
    }

    // The embedding derives from prompt/reference/choices. Recomputed the hash from
    // the merged row and compare to the stored one, so a hash-equal edit is left
    // alone; on real drift null the embedding so embed_backfill re-embeds. Derived
    // maintenance, so it stays out of before/after; a null embedding degrades to the
    // scalar path.
    if (
      Object.hasOwn(after, 'prompt_md') ||
      Object.hasOwn(after, 'reference_md') ||
      Object.hasOwn(after, 'choices_md') ||
      // structured also carries prompt/answer content, so it invalidates the same claims.
      Object.hasOwn(after, 'structured')
    ) {
      // Never leave an exact-identity hash pointing at pre-edit content; there is no
      // global backfill writer, so clear it rather than risk a stale duplicate match.
      if (row.canonical_content_hash != null) setValues.canonical_content_hash = null;
      // Also drop the archive claim snapshot: restoring an old hash would resurrect a
      // claim that no longer matches the content. The tombstone itself stays restorable.
      const rowMeta = row.metadata as Record<string, unknown> | null;
      if (rowMeta?.archived_content_hash != null) {
        const { archived_content_hash: _dropped, ...rest } = rowMeta;
        setValues.metadata = rest;
      }
      const nextEmbedText = questionEmbedText({
        prompt_md: patch.prompt_md !== undefined ? patch.prompt_md : row.prompt_md,
        reference_md: patch.reference_md !== undefined ? patch.reference_md : row.reference_md,
        choices_md: patch.choices_md !== undefined ? patch.choices_md : row.choices_md,
      });
      const nextHash = embedHash(nextEmbedText);
      if (nextHash !== row.embed_content_hash) {
        setValues.embedding = null;
        setValues.embed_content_hash = nextHash;
        setValues.embed_source_revision = null;
      }
    }

    // No real change: no event or version bump. Still honour optimistic locking so a
    // stale no-op reports a conflict and the caller refreshes.
    if (Object.keys(after).length === 0) {
      if (row.version !== expectedVersion) return { status: 'conflict' };
      return { status: 'noop', version: row.version };
    }

    // Lock the group root before touching a child: part edits republish the parent,
    // and all publishers/archivers/verifiers use root → child order.
    const willPublish = Object.keys(after).some((field) => PUBLISH_TRIGGERING_FIELDS.has(field));
    const groupRoot = row.parent_question_id ?? questionId;
    if (willPublish && row.parent_question_id != null) {
      await tx
        .select({ id: question.id })
        .from(question)
        .where(eq(question.id, row.parent_question_id))
        .for('update')
        .limit(1);
    }

    const updated = await tx
      .update(question)
      .set({ ...setValues, updated_at: now, version: row.version + 1 })
      .where(and(eq(question.id, questionId), eq(question.version, expectedVersion)))
      .returning({ version: question.version });
    if (updated.length === 0) return { status: 'conflict' };

    const eventId = createId();
    await writeEvent(tx, {
      id: eventId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: actorRef,
      action: QUESTION_EDIT_ACTION,
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        question_id: questionId,
        previous_version: row.version,
        next_version: row.version + 1,
        before,
        after,
      },
      created_at: now,
    });

    // Scoring-input changes republish in the same transaction (a part republishes its
    // parent). Noop/protected/composite branches returned earlier; conflicts fail closed.
    if (willPublish) {
      await publishQuestionGroupFromRow(tx, {
        rootId: groupRoot,
        actorRef: `question-edit:${actorRef}`,
        now,
      });
    }

    return { status: 'updated', event_id: eventId, version: row.version + 1 };
  });
}

export interface QuestionArchiveResult {
  status: 'archived' | 'conflict' | 'not_found' | 'protected';
  event_id?: string;
  /** Part ids cascade-archived with the parent. */
  cascaded_part_ids?: string[];
}

/**
 * Soft-archive by re-drafting (see file header), cascading live parts in the same
 * transaction and recording intent plus previous state in the event and metadata.
 */
export async function archiveQuestion(
  db: Db,
  questionId: string,
  expectedVersion: number,
  actorRef: string,
  reason = 'user',
): Promise<QuestionArchiveResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(question).where(eq(question.id, questionId)).limit(1);
    const row = rows[0];
    if (!row) return { status: 'not_found' };
    if (row.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) {
      return { status: 'protected' };
    }
    const [protectedChild] = await tx
      .select({ id: question.id })
      .from(question)
      .where(
        and(
          eq(question.parent_question_id, questionId),
          eq(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE),
          notDraftPredicate(question.draft_status),
        ),
      )
      .limit(1);
    if (protectedChild) {
      return { status: 'protected' };
    }

    // Root → child lock order. A root archive updates the root itself, so the UPDATE
    // already takes the root lock first.
    const archiveRootId = row.parent_question_id ?? questionId;
    if (row.parent_question_id != null) {
      const [rootLock] = await tx
        .select({ id: question.id })
        .from(question)
        .where(eq(question.id, archiveRootId))
        .for('update')
        .limit(1);
      if (!rootLock) return { status: 'not_found' };
    }

    const now = new Date();
    const archivedAtSec = Math.floor(now.getTime() / 1000);

    const parentUpdate = await tx
      .update(question)
      .set({
        draft_status: LEGACY_DRAFT_STATUS.DRAFT,
        // Release the exact-identity hash so the content can be produced again, but
        // keep it on metadata so restore re-acquires the same claim without recomputing.
        canonical_content_hash: null,
        metadata: {
          ...(row.metadata ?? {}),
          archived_at: archivedAtSec,
          archived_reason: reason,
          archived_previous_draft_status: row.draft_status ?? null,
          archived_content_hash: row.canonical_content_hash ?? null,
        },
        updated_at: now,
        version: row.version + 1,
      })
      .where(and(eq(question.id, questionId), eq(question.version, expectedVersion)))
      .returning({ id: question.id });
    if (parentUpdate.length === 0) return { status: 'conflict' };

    // Re-draft live parts so they do not outlive the parent in the pool. The FK
    // alone selects exactly this parent's parts; the display label is not consulted.
    const cascaded = await tx
      .update(question)
      .set({
        draft_status: LEGACY_DRAFT_STATUS.DRAFT,
        // Same hash release/retention as the parent; jsonb_build_object reads the
        // pre-UPDATE value per row.
        canonical_content_hash: null,
        metadata: sql`COALESCE(${question.metadata}, '{}'::jsonb) || jsonb_build_object(
          'archived_at', ${archivedAtSec}::numeric,
          'archived_reason', ${`cascade:${reason}`}::text,
          'archived_via_parent', ${questionId}::text,
          'archived_content_hash', ${question.canonical_content_hash}
        )`,
        updated_at: now,
        version: sql`${question.version} + 1`,
      })
      .where(
        and(eq(question.parent_question_id, questionId), notDraftPredicate(question.draft_status)),
      )
      .returning({ id: question.id });
    const cascadedPartIds = cascaded.map((r) => r.id);

    const eventId = createId();
    await writeEvent(tx, {
      id: eventId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: actorRef,
      action: 'experimental:question_archive',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        question_id: questionId,
        archived: true,
        reason,
        previous_draft_status: row.draft_status ?? null,
        previous_version: row.version,
        next_version: row.version + 1,
        cascaded_part_ids: cascadedPartIds,
      },
      created_at: now,
    });

    // Root archive withdraws the whole group (revisions/digests never change).
    // A part archive changes group content, so republish; the root lock is already
    // held and FromRow excludes tombstoned parts, withdrawing an empty group.
    if (row.parent_question_id != null) {
      await publishQuestionGroupFromRow(tx, {
        rootId: archiveRootId,
        actorRef: `question-archive:${actorRef}`,
        now,
      });
    } else {
      await archiveGroupLifecycle(tx, archiveRootId, now);
    }

    return { status: 'archived', event_id: eventId, cascaded_part_ids: cascadedPartIds };
  });
}

export interface QuestionRestoreResult {
  status: 'restored' | 'conflict' | 'not_found' | 'protected' | 'not_archived' | 'claim_conflict';
  event_id?: string;
  /** On claim_conflict: the question holding the same content hash. */
  conflicting_question_id?: string;
  /** Conflicting part id (empty for a root claim conflict). */
  conflicting_part_id?: string;
}

const ARCHIVED_METADATA_KEYS = [
  'archived_at',
  'archived_reason',
  'archived_previous_draft_status',
  'archived_via_parent',
  'archived_content_hash',
] as const;

/** Remove archive tombstone keys from metadata. */
function stripArchiveMetadata(meta: Record<string, unknown> | null): Record<string, unknown> {
  const next = { ...(meta ?? {}) };
  for (const k of ARCHIVED_METADATA_KEYS) delete next[k];
  return next;
}

/**
 * Reverse of archive in one transaction: lock the group root, restore lifecycle and
 * the dedup claim from metadata.archived_content_hash (never recomputed), cascade
 * parts this archive removed, and return to draft so owner/verify gates rerun.
 * A conflicting claim rolls back the whole restore. Suspension is preserved.
 */
export async function restoreQuestion(
  db: Db,
  questionId: string,
  expectedVersion: number,
  actorRef: string,
): Promise<QuestionRestoreResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(question).where(eq(question.id, questionId)).limit(1);
    const initialRow = rows[0];
    if (!initialRow) return { status: 'not_found' };
    if (initialRow.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) {
      return { status: 'protected' };
    }
    const initialMeta = (initialRow.metadata ?? {}) as Record<string, unknown>;
    if (initialMeta.archived_at == null) return { status: 'not_archived' };

    // Root → child lock order; reread the target and children only after taking it so
    // concurrent child edits cannot slip into the cascade decision.
    const groupRootId = initialRow.parent_question_id ?? questionId;
    const [rootLock] = await tx
      .select({ id: question.id })
      .from(question)
      .where(eq(question.id, groupRootId))
      .for('update')
      .limit(1);
    if (!rootLock) return { status: 'not_found' };

    // Authoritative in-lock reread for tombstone, version and claim snapshot.
    const [row] = await tx.select().from(question).where(eq(question.id, questionId)).limit(1);
    if (!row) return { status: 'not_found' };
    const rowMeta = (row.metadata ?? {}) as Record<string, unknown>;
    if (rowMeta.archived_at == null) return { status: 'not_archived' };

    const now = new Date();
    const cascadedParts =
      row.parent_question_id == null
        ? await tx
            .select({
              id: question.id,
              metadata: question.metadata,
              version: question.version,
            })
            .from(question)
            .where(eq(question.parent_question_id, questionId))
        : [];
    const restorableParts = cascadedParts.filter((p) => {
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      return meta.archived_via_parent === questionId && meta.archived_at != null;
    });

    // Claim re-acquisition: probe every holder before writing any hash so one conflict
    // rolls back the whole group. Missing archived_content_hash means no claim to restore.
    const claims: { id: string; hash: string }[] = [];
    if (typeof rowMeta.archived_content_hash === 'string' && rowMeta.archived_content_hash) {
      claims.push({ id: questionId, hash: rowMeta.archived_content_hash });
    }
    for (const part of restorableParts) {
      const meta = (part.metadata ?? {}) as Record<string, unknown>;
      if (typeof meta.archived_content_hash === 'string' && meta.archived_content_hash) {
        claims.push({ id: part.id, hash: meta.archived_content_hash });
      }
    }
    const claimsById = new Map(claims.map((c) => [c.id, c.hash]));
    for (const claim of claims) {
      const [holder] = await tx
        .select({ id: question.id })
        .from(question)
        .where(eq(question.canonical_content_hash, claim.hash))
        .limit(1);
      if (holder && holder.id !== claim.id) {
        return {
          status: 'claim_conflict',
          conflicting_question_id: holder.id,
          conflicting_part_id: claim.id === questionId ? undefined : claim.id,
        };
      }
    }

    // Reset the working copy (draft + tombstone keys cleared + claim re-stamped) under
    // expectedVersion CAS. Parts reset before republish so FromRow sees them again.
    const restored = await tx
      .update(question)
      .set({
        draft_status: LEGACY_DRAFT_STATUS.DRAFT,
        ...(claimsById.has(questionId)
          ? { canonical_content_hash: claimsById.get(questionId) }
          : {}),
        metadata: stripArchiveMetadata(rowMeta),
        updated_at: now,
        version: row.version + 1,
      })
      .where(and(eq(question.id, questionId), eq(question.version, expectedVersion)))
      .returning({ id: question.id });
    if (restored.length === 0) return { status: 'conflict' };

    for (const part of restorableParts) {
      const partMeta = (part.metadata ?? {}) as Record<string, unknown>;
      await tx
        .update(question)
        .set({
          draft_status: LEGACY_DRAFT_STATUS.DRAFT,
          ...(claimsById.has(part.id) ? { canonical_content_hash: claimsById.get(part.id) } : {}),
          metadata: stripArchiveMetadata(partMeta),
          updated_at: now,
          version: part.version + 1,
        })
        .where(eq(question.id, part.id));
    }

    // Root restore resets lifecycle and re-takes the claim (the internal re-probe is
    // idempotent). Part restore changes group content, so republish as archive does.
    if (row.parent_question_id == null) {
      const lifecycleResult = await restoreGroupLifecycle(
        tx,
        groupRootId,
        claimsById.get(questionId) ?? null,
        now,
      );
      if (lifecycleResult.status === 'claim_conflict') {
        return {
          status: 'claim_conflict',
          conflicting_question_id: lifecycleResult.conflicting_question_id,
        };
      }
      // No lifecycle row means a never-published archived draft; the publish chain
      // creates one if it is published again.
    } else {
      await publishQuestionGroupFromRow(tx, {
        rootId: groupRootId,
        actorRef: `question-restore:${actorRef}`,
        now,
      });
      // Undo an automatic withdrawal: a group with all parts tombstoned was withdrawn
      // by the publish chain, and restoring a part gives it live members again. An
      // explicit root archive keeps its own tombstone and is not reset here.
      const [rootRow] = await tx
        .select({ metadata: question.metadata })
        .from(question)
        .where(eq(question.id, groupRootId))
        .limit(1);
      const rootMeta = (rootRow?.metadata ?? {}) as Record<string, unknown>;
      if (rootRow && rootMeta.archived_at == null) {
        const [lifecycle] = await tx
          .select({
            withdrawn: question_group_lifecycle.withdrawn,
          })
          .from(question_group_lifecycle)
          .where(eq(question_group_lifecycle.group_id, groupRootId))
          .limit(1);
        if (lifecycle?.withdrawn) {
          await restoreGroupLifecycle(tx, groupRootId, null, now);
        }
      }
    }

    const eventId = createId();
    await writeEvent(tx, {
      id: eventId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: actorRef,
      action: 'experimental:question_restore',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        question_id: questionId,
        restored: true,
        previous_version: row.version,
        next_version: row.version + 1,
        restored_part_ids: restorableParts.map((p) => p.id),
        reclaimed_claim: claimsById.has(questionId),
      },
      created_at: now,
    });

    return { status: 'restored', event_id: eventId };
  });
}
