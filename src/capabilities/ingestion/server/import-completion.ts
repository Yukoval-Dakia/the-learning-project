/**
 * Completes an ingestion import: validates the client's blocks, materializes
 * questions and attempts, and records the session's terminal state.
 *
 * Imported failures produce a question, an attempt event, and optionally a judge
 * event; `mistake_id` is the attempt event id. The route passes `final_prompt_md`
 * directly, so both block shapes (structured jsonb or legacy prompt text) work here.
 */

import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
// Enrollment routes by outcome signal (ADR-0024), not a hardcoded failure shape.
import { enrollCapturedBlock } from '@/capabilities/ingestion/server/enroll';
import * as Ingestion from '@/capabilities/ingestion/server/session-lifecycle';
import { canonicalHash } from '@/core/migration/canonical';
import { structuredToPromptMarkdown } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { knowledge, learning_session, question, question_block } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { withActiveCauseCategoryOverlays } from '@/kernel/read-models/cause-overlay';
import {
  assertCauseAllowedForSubjectProfile,
  resolveSubjectProfileForKnowledgeIds,
} from '@/kernel/read-models/subject-profile';
import { resolveDocumentUsage } from '@/kernel/read-models/usage-policy';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { persistCapturedQuestionBlock } from '@/kernel/records/question-block-creation';
import { applyQuestionBlockTransition } from '@/kernel/records/question-block-transitions';
import { publishQuestionGroupFromRow } from '@/server/questions/publisher';
import type { SubjectProfile } from '@/subjects/profile';
import { ReviewBody, type ReviewBodyParsed } from '../api/operation-schema';
import { hasAgentEvidence } from './agent/history';
import { capturedQuestionShape } from './captured-question-shape';
import {
  isTerminalIngestionOperation,
  matchesAcceptedIngestionOperationInput,
  readIngestionOperation,
  writeIngestionOperationEvent,
} from './operation-store';
// Request-body schema and array bounds live in ./schema so they can be tested
// without the route's DB/R2/AI import graph.

export async function completeIngestionImport(
  db: Db | Tx,
  sessionId: string,
  body: import('../api/import-schema').ImportBodyParsed,
): Promise<{ question_ids: string[]; mistake_ids: string[]; record_ids: string[] }> {
  return db.transaction(async (tx) => {
    await Ingestion.assertSessionAvailableForImport(tx, sessionId);
    // Read source context under the same session lock as the authoritative status guard.
    const sessionRows = await tx
      .select()
      .from(learning_session)
      .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')));
    const session = sessionRows[0] ?? null;
    if (!session) {
      throw new ApiError('not_found', `learning_session ${sessionId} not found`, 404);
    }
    // learning_session is polymorphic, so the schema allows null; ingestion sessions
    // always set both fields at upload time.
    if (session.entrypoint === null) {
      throw new ApiError(
        'validation_error',
        `learning_session ${sessionId} (type=ingestion) is missing entrypoint`,
        400,
      );
    }
    const sessionEntrypoint: string = session.entrypoint;
    if (session.source_document_id === null) {
      throw new ApiError(
        'validation_error',
        `learning_session ${sessionId} (type=ingestion) is missing source_document_id`,
        400,
      );
    }
    const sessionSourceDocumentId: string = session.source_document_id;
    // Resolve usage once per session instead of paying an unindexed lookup per block.
    const sessionDocUsage = await resolveDocumentUsage(tx, sessionSourceDocumentId);

    const sessionAssetIds = session.source_asset_ids as string[];
    const sessionAssetSet = new Set(sessionAssetIds);

    // Every source_block_id must belong to this session, and block_id (if present)
    // must be in source_block_ids.
    const sourceBlockRows = new Map<string, typeof question_block.$inferSelect>();
    const allSourceIds = new Set<string>();
    for (const block of body.blocks) {
      const isManual = block.block_id === undefined && block.source_block_ids.length === 0;
      if (isManual && block.image_refs.length === 0) {
        throw new ApiError(
          'validation_error',
          'manual block must reference at least one image_ref',
          400,
        );
      }
      for (const sid of block.source_block_ids) allSourceIds.add(sid);
      if (block.block_id !== undefined && !block.source_block_ids.includes(block.block_id)) {
        throw new ApiError(
          'validation_error',
          `block_id ${block.block_id} must be in its source_block_ids`,
          400,
        );
      }
    }

    for (const sid of allSourceIds) {
      const rows = await tx.select().from(question_block).where(eq(question_block.id, sid));
      const row = rows[0] ?? null;
      if (!row) {
        throw new ApiError('validation_error', `unknown source_block_id: ${sid}`, 400);
      }
      if (row.ingestion_session_id !== sessionId) {
        throw new ApiError(
          'validation_error',
          `source_block_id ${sid} does not belong to session ${sessionId}`,
          400,
        );
      }
      // Merge/split sources must still be draft; consuming a terminal source would
      // orphan its question/attempt. The session lock holds all block locks to commit.
      if (row.status !== 'draft') {
        throw new ApiError(
          'conflict',
          `source_block_id ${sid} is '${row.status}'; only 'draft' blocks can be imported`,
          409,
        );
      }
      sourceBlockRows.set(sid, row);
    }

    // image_refs must belong to session.source_asset_ids.
    for (const block of body.blocks) {
      for (const ref of block.image_refs) {
        if (!sessionAssetSet.has(ref)) {
          throw new ApiError(
            'validation_error',
            `image_ref ${ref} not in session source_asset_ids`,
            400,
          );
        }
      }
    }

    // page_spans' page_index must be within the session's asset count.
    for (const block of body.blocks) {
      for (const span of block.page_spans) {
        if (span.page_index >= sessionAssetIds.length) {
          throw new ApiError(
            'validation_error',
            `page_index ${span.page_index} out of range (session has ${sessionAssetIds.length} assets)`,
            400,
          );
        }
      }
    }

    // Client knowledge_ids are authoritative and required. Import carries no
    // subject signal, so tagKnowledge cannot resolve a PROPOSE root for empty ids.
    const effectiveKnowledgeIds: string[][] = body.blocks.map((b) => b.knowledge_ids);

    // Validate the batch's subject attribution before any materialization.
    const requestedKnowledgeIds = [...new Set(effectiveKnowledgeIds.flat())];
    const foundKnowledgeRows = await tx
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(inArray(knowledge.id, requestedKnowledgeIds), isNull(knowledge.archived_at)));
    const foundKnowledgeIds = new Set(foundKnowledgeRows.map((row) => row.id));
    const missingKnowledgeId = requestedKnowledgeIds.find((id) => !foundKnowledgeIds.has(id));
    if (missingKnowledgeId) {
      throw new ApiError(
        'validation_error',
        `unknown or archived knowledge_id: ${missingKnowledgeId}`,
        400,
      );
    }
    const blockSubjectProfiles = await Promise.all(
      effectiveKnowledgeIds.map(async (ids) => resolveSubjectProfileForKnowledgeIds(tx, ids)),
    );
    // Allowed causes are declaration ∪ active overlays; cache per profile id so
    // blocks sharing a subject do not re-query overlays.
    const effectiveProfileCache = new Map<string, SubjectProfile>();
    for (const [index, block] of body.blocks.entries()) {
      const declared = blockSubjectProfiles[index];
      let effective = effectiveProfileCache.get(declared.id);
      if (!effective) {
        effective = await withActiveCauseCategoryOverlays(tx, declared);
        effectiveProfileCache.set(declared.id, effective);
      }
      assertCauseAllowedForSubjectProfile(block.cause, effective);
    }

    const now = new Date();

    const directlyImportedIds = new Set<string>();
    for (const b of body.blocks) {
      if (b.block_id !== undefined) directlyImportedIds.add(b.block_id);
    }
    const hasManualBlocks = body.blocks.some(
      (block) => block.block_id === undefined && block.source_block_ids.length === 0,
    );

    const questionIds: string[] = [];
    const mistakeIds: string[] = [];
    const recordIds: string[] = [];
    // Manual cards have no source position, so append after the session max. The
    // session lock makes this base stable for the transaction.
    let manualOrdinalBase = 0;
    if (hasManualBlocks) {
      const [ordinalRow] = await tx
        .select({ maxOrdinal: sql<number | null>`max(${question_block.ordinal})` })
        .from(question_block)
        .where(eq(question_block.ingestion_session_id, sessionId));
      manualOrdinalBase = (ordinalRow?.maxOrdinal ?? -1) + 1;
    }

    const toIgnore = new Set<string>();

    for (const [blockIndex, block] of body.blocks.entries()) {
      // Attribution is the client-supplied ids; import never calls tagKnowledge.
      const blockKnowledgeIds = effectiveKnowledgeIds[blockIndex];
      let importedBlockId: string;
      let importedVisualComplexity: string | null = null;

      if (block.block_id !== undefined) {
        importedBlockId = block.block_id;
        importedVisualComplexity = sourceBlockRows.get(block.block_id)?.visual_complexity ?? null;
      } else {
        // Virtual card (merged or split): INSERT new question_block
        importedBlockId = createId();
        const sourceRows = block.source_block_ids
          .map((sid) => sourceBlockRows.get(sid))
          .filter((r): r is typeof question_block.$inferSelect => r !== undefined);
        const visualComplexity = sourceRows.some((r) => r.visual_complexity === 'high')
          ? 'high'
          : sourceRows.some((r) => r.visual_complexity === 'medium')
            ? 'medium'
            : 'low';
        if (sourceRows.length > 0) importedVisualComplexity = visualComplexity;
        // Extraction order is the reading order. A virtual card takes the minimum
        // source ordinal so it stays in the same namespace; split siblings share it
        // and the (ordinal, id) sort tiebreaks. Manual cards append past the session
        // max, with blockIndex preserving request order.
        const ordinal =
          sourceRows.length > 0
            ? Math.min(...sourceRows.map((r) => r.ordinal))
            : manualOrdinalBase + blockIndex;

        await persistCapturedQuestionBlock(
          tx,
          {
            origin: 'import',
            blockId: importedBlockId,
            sessionId,
            sourceDocumentId: sessionSourceDocumentId,
            ordinal,
            visualComplexity,
            pageSpans: block.page_spans,
            imageRefs: block.image_refs,
            sourceBlockIds: block.source_block_ids,
            finalPromptMd: block.final_prompt_md,
            finalReferenceMd: block.final_reference_md,
            finalWrongAnswerMd: block.final_wrong_answer_md,
          },
          now,
        );

        for (const sid of block.source_block_ids) {
          if (!directlyImportedIds.has(sid)) {
            toIgnore.add(sid);
          }
        }
      }

      const wrongAnswerImageRefs = [
        ...new Set(
          block.page_spans
            .filter((s) => s.role === 'answer_area')
            .map((s) => sessionAssetIds[s.page_index])
            .filter((id): id is string => typeof id === 'string' && block.image_refs.includes(id)),
        ),
      ];

      // Derive figures/image_refs from the source block. A merged card concatenates
      // figures and has no structured tree; a manual block has neither. The legacy
      // metadata.prompt_image_refs field is still written for older readers.
      let importedFigures: typeof question_block.$inferSelect.figures = [];
      let importedStructured: typeof question_block.$inferSelect.structured = null;
      if (block.block_id !== undefined) {
        const sourceRow = sourceBlockRows.get(block.block_id);
        if (sourceRow) {
          importedFigures = sourceRow.figures;
          // Keep structured only when prompt_md still derives from it (ADR-0002).
          // An edited prompt makes prompt_text stale, so drop it; later edits go
          // through the domain tool path, not bulk import.
          if (sourceRow.structured) {
            const derived = structuredToPromptMarkdown(sourceRow.structured);
            importedStructured = derived === block.final_prompt_md ? sourceRow.structured : null;
          }
        }
      } else if (block.source_block_ids.length > 0) {
        // virtual card from merge: concat figures, structured=null
        const sourceRows = block.source_block_ids
          .map((sid) => sourceBlockRows.get(sid))
          .filter((r): r is typeof question_block.$inferSelect => r !== undefined);
        importedFigures = sourceRows.flatMap((r) => r.figures);
      }

      const pendingCaptures =
        block.source_block_ids.length === 0
          ? []
          : await tx
              .select()
              .from(question)
              .where(
                and(
                  sql`${question.metadata}->>'ingestion_session_id' = ${sessionId}`,
                  sql`${question.metadata}->>'question_block_id' IN (${sql.join(
                    block.source_block_ids.map((id) => sql`${id}`),
                    sql`, `,
                  )})`,
                  sql`${question.metadata}->>'capture_block_version' IS NOT NULL`,
                ),
              );
      const sourceRow = block.block_id ? sourceBlockRows.get(block.block_id) : undefined;
      const reusable =
        block.source_block_ids.length === 1 &&
        sourceRow &&
        (sourceRow.wrong_answer_md ?? '') === block.final_wrong_answer_md
          ? pendingCaptures.find(
              (row) =>
                row.metadata?.capture_block_version === sourceRow.version &&
                row.kind === block.question_kind &&
                row.prompt_md === block.final_prompt_md &&
                row.reference_md === block.final_reference_md &&
                row.difficulty === block.difficulty &&
                canonicalHash(row.knowledge_ids) === canonicalHash(blockKnowledgeIds) &&
                canonicalHash(row.figures) === canonicalHash(importedFigures) &&
                canonicalHash(row.image_refs) === canonicalHash(block.image_refs) &&
                canonicalHash(row.structured) === canonicalHash(importedStructured),
            )
          : undefined;
      const questionId = reusable?.id ?? createId();
      questionIds.push(questionId);
      const questionMetadata = {
        ...(reusable?.metadata ?? {}),
        ...(pendingCaptures.length > 0
          ? { captured_original_question_ids: pendingCaptures.map((row) => row.id) }
          : {}),
        // Legacy reader compat; new code reads question.image_refs.
        prompt_image_refs: block.image_refs,
        prompt_image_ref_kind: 'source_asset_id',
        source_document_id: sessionSourceDocumentId,
        ingestion_session_id: sessionId,
        question_block_id: importedBlockId,
      };
      if (reusable) {
        await tx
          .update(question)
          .set({ draft_status: null, metadata: questionMetadata, updated_at: now })
          .where(eq(question.id, questionId));
      } else {
        await tx.insert(question).values(
          withAnswerClass({
            id: questionId,
            kind: block.question_kind,
            choices_md: capturedQuestionShape(importedStructured).choices_md,
            prompt_md: block.final_prompt_md,
            reference_md: block.final_reference_md,
            knowledge_ids: blockKnowledgeIds,
            difficulty: block.difficulty,
            visual_complexity: importedVisualComplexity,
            source: sessionEntrypoint,
            draft_status: null,
            variant_depth: 0,
            figures: importedFigures,
            image_refs: block.image_refs,
            structured: importedStructured,
            metadata: questionMetadata,
            created_at: now,
            updated_at: now,
            version: 0,
          }),
        );

        // Mint the first revision in the same transaction. It starts withheld: the
        // import's scoring input is contractual but not yet verified.
        await publishQuestionGroupFromRow(tx, {
          rootId: questionId,
          actorRef: 'import-completion:question',
          now,
        });
      }

      // enrollCapturedBlock routes by outcome: failure creates a mistake, success
      // and partial create mastery evidence without FSRS advance, and unanswered
      // creates an open-question item (ADR-0024).
      const enroll = await enrollCapturedBlock(tx, {
        questionId,
        outcome: block.outcome,
        answerMd: block.final_wrong_answer_md,
        answerImageRefs: wrongAnswerImageRefs,
        knowledgeIds: blockKnowledgeIds,
        imageRefs: block.image_refs,
        captureMode: block.image_refs.length > 0 ? 'image' : 'text',
        sourceDocumentId: sessionSourceDocumentId,
        docUsage: sessionDocUsage,
        now,
      });

      // Legacy mistake_id token: the attempt event id, or the record id for unanswered.
      const mistakeId = enroll.attemptEventId ?? enroll.recordId;
      mistakeIds.push(mistakeId);
      recordIds.push(enroll.recordId);

      // Link the block to the question/attempt and mark it imported.
      await applyQuestionBlockTransition(
        tx,
        {
          kind: 'complete_import',
          blockId: importedBlockId,
          questionId,
          attemptEventId: enroll.attemptEventId,
        },
        now,
      );
    }

    // Mark draft blocks the user dropped as ignored.
    const sessionDrafts = await tx
      .select({ id: question_block.id })
      .from(question_block)
      .where(
        and(eq(question_block.ingestion_session_id, sessionId), eq(question_block.status, 'draft')),
      );
    for (const r of sessionDrafts) {
      if (!directlyImportedIds.has(r.id) && !toIgnore.has(r.id)) {
        toIgnore.add(r.id);
      }
    }

    for (const sid of toIgnore) {
      await applyQuestionBlockTransition(tx, { kind: 'ignore_source', blockId: sid }, now);
    }

    // Terminal transition extracted | reviewed → imported, re-asserted under the lock.
    await Ingestion.commitImport(tx, sessionId);

    // Failure learning follows from the committed attempts via the practice-owned
    // durable subscription; ingestion knows no queue names.

    return {
      question_ids: questionIds,
      mistake_ids: mistakeIds,
      record_ids: recordIds,
    };
  });
}

/** Durable delivery owns its receipt in the same transaction as the imported facts.
 * Duplicate deliveries serialize here. Infrastructure/receipt failures roll everything
 * back and propagate for queue retry; domain rejection is a terminal operation result.
 */
export async function completeIngestionImportOperation(
  db: Db,
  input: {
    operationId: string;
    sessionId: string;
    body: import('../api/import-schema').ImportBodyParsed;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('ingestion-import-settlement'), hashtext(${input.operationId}))`,
    );
    const operation = await readIngestionOperation(tx, input.operationId);
    if (!operation || isTerminalIngestionOperation(operation)) return;
    if (operation.operation_kind !== 'import' || operation.session_id !== input.sessionId) {
      throw new ApiError('conflict', 'Import delivery does not match its reserved operation', 409);
    }
    await writeIngestionOperationEvent(tx, {
      operationId: input.operationId,
      eventType: 'operation.running',
    });
    let result: Awaited<ReturnType<typeof completeIngestionImport>>;
    try {
      result = await completeIngestionImport(tx, input.sessionId, input.body);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await writeIngestionOperationEvent(tx, {
        operationId: input.operationId,
        eventType: 'operation.failed',
        payload: { error: { code: error.code, message: error.message, status: error.status } },
      });
      return;
    }
    // Keep this outside the domain-error catch: failure to write DONE must roll back
    // the imported rows, never turn committed business success into a false FAILED.
    await writeIngestionOperationEvent(tx, {
      operationId: input.operationId,
      eventType: 'operation.completed',
      payload: { result },
    });
  });
}

/**
 * Classic review owns the full checked set and its completion receipt. Lock order:
 * operation → session → blocks ordered by id. No publishing or paid work occurs.
 */
export async function completeIngestionReviewOperation(
  db: Db,
  input: { operationId: string; sessionId: string; body: ReviewBodyParsed },
): Promise<void> {
  await db.transaction(async (tx) => {
    // Share dispatch's exact per-operation lock through business + receipt commit:
    // an ambiguous send must finish its terminal write before review re-reads it.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'ingestion-operation-dispatch'}), hashtext(${input.operationId}))`,
    );
    const operation = await readIngestionOperation(tx, input.operationId);
    if (!operation || isTerminalIngestionOperation(operation)) return;
    const parsed = ReviewBody.safeParse(input.body);
    if (
      !parsed.success ||
      operation.operation_kind !== 'review' ||
      operation.session_id !== input.sessionId ||
      !(await matchesAcceptedIngestionOperationInput(tx, {
        operationId: input.operationId,
        sessionId: input.sessionId,
        request: { kind: 'review', input: parsed.data },
      }))
    ) {
      // A foreign delivery must not terminalize the real accepted operation.
      throw new ApiError('conflict', 'Review delivery does not match its reserved operation', 409);
    }
    const body = parsed.data;
    await writeIngestionOperationEvent(tx, {
      operationId: input.operationId,
      eventType: 'operation.running',
    });
    try {
      // The savepoint rolls back every review write before a domain failure receipt.
      // Infrastructure errors escape the outer transaction for pg-boss retry.
      await tx.transaction(async (reviewTx) => {
        const [session] = await reviewTx
          .select({ id: learning_session.id })
          .from(learning_session)
          .where(
            and(eq(learning_session.id, input.sessionId), eq(learning_session.type, 'ingestion')),
          )
          .for('update');
        if (!session) {
          throw new ApiError('not_found', `ingestion session ${input.sessionId} not found`, 404);
        }
        // This is the same live classifier used by history, including historical
        // drafts, grants and unknown paid runs. Partial status never proves classic.
        if (await hasAgentEvidence(reviewTx, input.sessionId)) {
          throw new ApiError('conflict', 'Agent sessions cannot use classic block review', 409);
        }
        const blocks = await reviewTx
          .select({ id: question_block.id, version: question_block.version })
          .from(question_block)
          .where(eq(question_block.ingestion_session_id, input.sessionId))
          .orderBy(asc(question_block.id))
          .for('update');
        // No draft/status filter or limit: ignored and auto-enrolled rows count too.
        const checked = new Map(
          body.checked_blocks.map((block) => [block.block_id, block.version]),
        );
        if (
          blocks.length === 0 ||
          blocks.length !== checked.size ||
          blocks.some((block) => checked.get(block.id) !== block.version)
        ) {
          throw new ApiError(
            'conflict',
            'Checked blocks must match every current session block and version; review again',
            409,
          );
        }
        // Preserve the state owner's extracted/partial guard and reviewed event.
        await Ingestion.markReviewedInTx(reviewTx, input.sessionId);
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status >= 500) throw error;
      await writeIngestionOperationEvent(tx, {
        operationId: input.operationId,
        eventType: 'operation.failed',
        payload: { error: { code: error.code, message: error.message, status: error.status } },
      });
      return;
    }
    // DONE failures roll back reviewed and ingestion.reviewed together; they can
    // never be caught above and downgraded into a false failed operation.
    await writeIngestionOperationEvent(tx, {
      operationId: input.operationId,
      eventType: 'operation.completed',
      payload: { result: { status: 'reviewed' } },
    });
  });
}
