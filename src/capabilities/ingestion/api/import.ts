/**
 * POST /api/ingestion/[id]/import
 *
 * Phase 1c.1 Step 9.G: legacy mistake row INSERTs removed. Each imported
 * failure block now produces only:
 *   - question row (canonical)
 *   - attempt event (outcome='failure') chained to the question
 *   - optional AI-attributed judge event (queued via runAttributionAndWriteJudgeEvent)
 *
 * `mistake_id` on the wire equals the attempt event id (opaque to clients).
 *
 * **混合 schema 提示**（PR #30 review #7）：
 * post-Sub-0c 抽取写的 question_block 有 `structured` jsonb，`extracted_prompt_md` 为 null；
 * pre-Sub-0c 已存在的行反之。本 route 不读这两个字段（client 在 body 里直接传
 * `final_prompt_md`），所以兼容；但**未来 UI** 渲染 block 列表时要同时处理两种形态，
 * 或派生 `structuredToPromptMarkdown(structured)` 作为统一展示源。
 */
import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

// T-OC slice 1 (YUK-145, OC-3): generalized capture — outcome is a signal,
// routed by enrollCapturedBlock instead of the old hardcoded
// attempt(outcome='failure') + learning_record(kind='mistake'). See ADR-0024.
import { enrollCapturedBlock } from '@/capabilities/ingestion/server/enroll';
import { structuredToPromptMarkdown } from '@/core/schema/structured_question';
import { db } from '@/db/client';
import { knowledge, learning_session, question, question_block } from '@/db/schema';
import { runTask } from '@/server/ai/runner';
import { getStartedBoss } from '@/server/boss/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { runProposeAndWrite } from '@/server/knowledge/propose';
import {
  assertCauseAllowedForSubjectProfile,
  resolveSubjectProfileForKnowledgeIds,
} from '@/server/knowledge/subject-profile';
import { getR2 } from '@/server/r2';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import { Ingestion } from '@/server/session';
import type { SubjectProfile } from '@/subjects/profile';
// YUK-234 (SEC-4): request-body schema (incl. per-array .max() bounds) lives in
// ./schema so the bounds are unit-testable without the route's DB/R2/AI import
// graph. The capture-outcome / cause / kind semantics are unchanged.
import { ImportBody } from './import-schema';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const sessionId = params.id;
    const raw = await req.json().catch(() => null);
    const parsed = ImportBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const body = parsed.data;

    // 1. Validate session exists and is in an importable state. Reads from
    //    learning_session (Step 5 post-migration). Status-machine guard is
    //    applied a second time at commit time by Ingestion.commitImport (also
    //    holds a FOR UPDATE lock).
    const sessionRows = await db
      .select()
      .from(learning_session)
      .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')));
    const session = sessionRows[0] ?? null;
    if (!session) {
      throw new ApiError('not_found', `learning_session ${sessionId} not found`, 404);
    }
    if (session.status !== 'extracted' && session.status !== 'reviewed') {
      throw new ApiError(
        'conflict',
        `learning_session ${sessionId} is in status '${session.status}'; only 'extracted' or 'reviewed' can be imported`,
        409,
      );
    }
    // type='ingestion' invariant — these fields are required for the import flow.
    // The DB schema marks them nullable because learning_session is polymorphic;
    // an ingestion-flavored session always has both set (initiateUpload enforces it).
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

    const sessionAssetIds = session.source_asset_ids as string[];
    const sessionAssetSet = new Set(sessionAssetIds);

    // 2. Validate every source_block_id belongs to this session, and block_id (if present) is in source_block_ids
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
      const rows = await db.select().from(question_block).where(eq(question_block.id, sid));
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
      // B1b (YUK-164 §2): a merge/split source must still be 'draft' — an
      // already-auto_enrolled (or imported/ignored) source can't be consumed into
      // a virtual card (would orphan its auto-enroll question/attempt without a
      // retract). Revert it via OC-5 first. Mirrors the direct-import guard below.
      if (row.status !== 'draft') {
        throw new ApiError(
          'conflict',
          `source_block_id ${sid} is '${row.status}'; only 'draft' blocks can be imported`,
          409,
        );
      }
      sourceBlockRows.set(sid, row);
    }

    // 3. Validate image_refs belong to session.source_asset_ids
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

    // 3b. Validate page_spans page_index against session asset count
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

    // 4. Validate knowledge_ids
    for (const block of body.blocks) {
      for (const kid of block.knowledge_ids) {
        const rows = await db
          .select({ id: knowledge.id })
          .from(knowledge)
          .where(and(eq(knowledge.id, kid), isNull(knowledge.archived_at)));
        if (rows.length === 0) {
          throw new ApiError('validation_error', `unknown or archived knowledge_id: ${kid}`, 400);
        }
      }
    }
    const blockSubjectProfiles = await Promise.all(
      body.blocks.map(async (block) =>
        resolveSubjectProfileForKnowledgeIds(db, block.knowledge_ids),
      ),
    );
    for (const [index, block] of body.blocks.entries()) {
      assertCauseAllowedForSubjectProfile(block.cause, blockSubjectProfiles[index]);
    }

    // ---- All validation passed; build and execute batch ----
    // Codex P1-A: write phase + commitImport MUST share a transaction so the
    // status-machine check (FOR UPDATE lock acquired by
    // Ingestion.assertSessionAvailableForImport) gates concurrent double-submit.
    // Without this, two POSTs both pass the per-row pre-checks above, both INSERT
    // question/mistake/question_block rows, then race in commitImport — the loser
    // throws 409 AFTER its writes have already committed (partial side effects
    // + duplicate imports on retry).
    const now = new Date();

    const directlyImportedIds = new Set<string>();
    for (const b of body.blocks) {
      if (b.block_id !== undefined) directlyImportedIds.add(b.block_id);
    }

    const questionIds: string[] = [];
    const mistakeIds: string[] = [];
    const recordIds: string[] = [];
    const queueData: Array<{
      mistakeId: string;
      attemptEventId: string;
      prompt_md: string;
      reference_md: string | null;
      wrong_answer_md: string;
      knowledge_ids: string[];
      cause: { primary_category: string; user_notes: string | null } | null;
      subjectProfile: SubjectProfile;
    }> = [];

    await db.transaction(async (tx) => {
      // SELECT … FOR UPDATE on the session row + asserts importable status.
      // Concurrent callers serialise here; the second to acquire the lock sees
      // status='imported' and throws 409 before any writes happen.
      await Ingestion.assertSessionAvailableForImport(tx, sessionId);

      // B1b (YUK-164 §2): only 'draft' blocks are importable. A block already
      // 'auto_enrolled' (WorkflowJudge) / 'imported' / 'ignored' must NOT be
      // re-imported — that would duplicate the question + attempt. Reject loudly
      // (no silent skip): the OC-5 surface reverts an auto_enrolled block back to
      // 'draft' before it can be human-imported. Unreachable until the enroll flag
      // is ON (no auto_enrolled blocks exist in prod today), but this guard MUST
      // precede that flip — see the design note §2.
      if (directlyImportedIds.size > 0) {
        const existingBlocks = await tx
          .select({ id: question_block.id, status: question_block.status })
          .from(question_block)
          .where(inArray(question_block.id, [...directlyImportedIds]));
        const nonDraft = existingBlocks.filter((b) => b.status !== 'draft');
        if (nonDraft.length > 0) {
          throw new ApiError(
            'conflict',
            `cannot import blocks that are not 'draft': ${nonDraft
              .map((b) => `${b.id} (${b.status})`)
              .join(', ')}`,
            409,
          );
        }
      }

      const toIgnore = new Set<string>();

      for (const [blockIndex, block] of body.blocks.entries()) {
        const subjectProfile = blockSubjectProfiles[blockIndex];
        let importedBlockId: string;

        if (block.block_id !== undefined) {
          importedBlockId = block.block_id;
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

          await tx.insert(question_block).values({
            id: importedBlockId,
            ingestion_session_id: sessionId,
            source_document_id: sessionSourceDocumentId,
            source_asset_ids: block.image_refs,
            page_spans: block.page_spans,
            extracted_prompt_md: block.final_prompt_md,
            reference_md: block.final_reference_md,
            wrong_answer_md: block.final_wrong_answer_md,
            image_refs: block.image_refs,
            crop_refs: [],
            visual_complexity: visualComplexity,
            extraction_confidence: 1,
            status: 'imported',
            knowledge_hint: null,
            merged_from_block_ids: block.source_block_ids,
            imported_question_id: null,
            imported_attempt_event_id: null,
            created_at: now,
            updated_at: now,
            version: 0,
          });

          for (const sid of block.source_block_ids) {
            if (!directlyImportedIds.has(sid)) {
              toIgnore.add(sid);
            }
          }
        }

        // Compute wrong_answer_image_refs
        const wrongAnswerImageRefs = [
          ...new Set(
            block.page_spans
              .filter((s) => s.role === 'answer_area')
              .map((s) => sessionAssetIds[s.page_index])
              .filter(
                (id): id is string => typeof id === 'string' && block.image_refs.includes(id),
              ),
          ),
        ];

        // INSERT question — M-1 (2026-05-21): write figures / image_refs / structured
        // first-class. Derive from source question_block row(s):
        // - direct import: read from sourceBlockRows[block_id]
        // - virtual card (merged): concat figures from all source rows; structured
        //   has no clean merge semantic so it's null (a merged card is a new question
        //   created by the user, not an extraction tree)
        // - manual block: nothing to derive from; both empty/null
        // `metadata.prompt_image_refs` remains for legacy reader compat (M3+ removal).
        let importedFigures: typeof question_block.$inferSelect.figures = [];
        let importedStructured: typeof question_block.$inferSelect.structured = null;
        if (block.block_id !== undefined) {
          const sourceRow = sourceBlockRows.get(block.block_id);
          if (sourceRow) {
            importedFigures = sourceRow.figures;
            // Carry `structured` only if `final_prompt_md` still matches what
            // would be derived from `structured`. If the user edited the prompt
            // pre-import, structured's prompt_text is stale and would violate
            // ADR-0002 revision 2026-05-21 ("when structured is non-null,
            // prompt_md MUST be regenerable from structured"). Drop structured
            // in that case — a future structured edit must go through the
            // domain tool path, not bulk import.
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
        // else: manual block (no source) — figures=[], structured=null (defaults)

        const questionId = createId();
        questionIds.push(questionId);
        const questionMetadata = {
          // deprecated (M-1 / 2026-05-21): new code reads question.image_refs (first-class).
          // Kept for legacy reader compat; M3 后视使用情况移除。
          prompt_image_refs: block.image_refs,
          prompt_image_ref_kind: 'source_asset_id',
          source_document_id: sessionSourceDocumentId,
          ingestion_session_id: sessionId,
          question_block_id: importedBlockId,
        };
        await tx.insert(question).values({
          id: questionId,
          kind: block.question_kind,
          prompt_md: block.final_prompt_md,
          reference_md: block.final_reference_md,
          knowledge_ids: block.knowledge_ids,
          difficulty: block.difficulty,
          source: sessionEntrypoint,
          variant_depth: 0,
          figures: importedFigures,
          image_refs: block.image_refs,
          structured: importedStructured,
          metadata: questionMetadata,
          created_at: now,
          updated_at: now,
          version: 0,
        });

        // T-OC slice 1 (YUK-145, OC-3): generalized capture. The capture's
        // `outcome` is a SIGNAL routed by enrollCapturedBlock — failure → attempt
        // (failure)+mistake (existing attribution chain); success/partial →
        // attempt(success|partial)+worked_example (mastery evidence, NO FSRS
        // advance — ADR-0024); unanswered → open_question item (no attempt event).
        const enroll = await enrollCapturedBlock(tx, {
          questionId,
          outcome: block.outcome,
          answerMd: block.final_wrong_answer_md,
          answerImageRefs: wrongAnswerImageRefs,
          knowledgeIds: block.knowledge_ids,
          imageRefs: block.image_refs,
          captureMode: block.image_refs.length > 0 ? 'image' : 'text',
          sourceDocumentId: sessionSourceDocumentId,
          now,
        });

        // Back-compat `mistake_id` token: the attempt event id for
        // failure/success/partial; the record id when unanswered has no attempt.
        const mistakeId = enroll.attemptEventId ?? enroll.recordId;
        mistakeIds.push(mistakeId);
        recordIds.push(enroll.recordId);

        // UPDATE question_block: link to question + attempt event (null for
        // unanswered captures), transition to 'imported'.
        await tx
          .update(question_block)
          .set({
            imported_question_id: questionId,
            imported_attempt_event_id: enroll.attemptEventId,
            status: 'imported',
            updated_at: now,
            version: sql`${question_block.version} + 1`,
          })
          .where(eq(question_block.id, importedBlockId));

        // Only failure captures have a cause to attribute. success/partial/
        // unanswered never queue attribution_followup.
        if (enroll.needsAttribution && enroll.attemptEventId !== null) {
          queueData.push({
            mistakeId,
            attemptEventId: enroll.attemptEventId,
            prompt_md: block.final_prompt_md,
            reference_md: block.final_reference_md,
            wrong_answer_md: block.final_wrong_answer_md,
            knowledge_ids: block.knowledge_ids,
            cause: block.cause,
            subjectProfile,
          });
        }
      }

      // Sweep: mark any draft blocks user dropped as 'ignored'
      const sessionDrafts = await tx
        .select({ id: question_block.id })
        .from(question_block)
        .where(
          and(
            eq(question_block.ingestion_session_id, sessionId),
            eq(question_block.status, 'draft'),
          ),
        );
      for (const r of sessionDrafts) {
        if (!directlyImportedIds.has(r.id) && !toIgnore.has(r.id)) {
          toIgnore.add(r.id);
        }
      }

      // UPDATE source blocks → status='ignored'
      for (const sid of toIgnore) {
        await tx
          .update(question_block)
          .set({
            status: 'ignored',
            updated_at: now,
            version: sql`${question_block.version} + 1`,
          })
          .where(eq(question_block.id, sid));
      }

      // Terminal transition extracted | reviewed → imported. Re-asserts state
      // under the same lock (no-op vs assertSessionAvailableForImport above
      // unless something inside the txn mutated it, which is impossible).
      await Ingestion.commitImport(tx, sessionId);
    });

    // Queue post-write tasks (fire-and-forget with Promise.allSettled)
    const r2 = getR2();
    void Promise.allSettled(
      queueData.flatMap((q) => {
        const tasks: Promise<void>[] = [];
        tasks.push(
          runProposeAndWrite({
            db,
            mistakeContent: {
              prompt_md: q.prompt_md,
              reference_md: q.reference_md,
              wrong_answer_md: q.wrong_answer_md,
              knowledge_ids_picked: q.knowledge_ids,
            },
            runTaskFn: async (kind, input) => {
              const result = await runTask(kind, input, {
                db,
                r2,
                subjectProfile: q.subjectProfile,
              });
              return { text: result.text };
            },
            subjectProfile: q.subjectProfile,
          }).catch((err) => {
            console.error('propose prep failed (mistake unaffected)', err);
          }),
        );
        // Task #16: attribution via pg-boss instead of inline. Worker process
        // owns the LLM call; ingestion route returns as soon as DB writes
        // commit.
        if (q.cause === null && shouldEnqueueBackgroundJobs()) {
          tasks.push(
            (async () => {
              try {
                const boss = await getStartedBoss();
                await boss.send('attribution_followup', {
                  attempt_event_id: q.attemptEventId,
                });
              } catch (err) {
                console.warn(`attribution_followup enqueue failed for ${q.attemptEventId}:`, err);
              }
            })(),
          );
        }
        return tasks;
      }),
    );

    return Response.json({
      question_ids: questionIds,
      mistake_ids: mistakeIds,
      record_ids: recordIds,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
