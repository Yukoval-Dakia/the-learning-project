import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { PageSpan } from '@/core/schema';
import { type Cause, CauseCategory, QuestionKind } from '@/core/schema/business';
import { db } from '@/db/client';
import { ingestion_session, knowledge, mistake, question, question_block } from '@/db/schema';
import { runTask } from '@/server/ai/runner';
import { ApiError, errorResponse } from '@/server/http/errors';
import { runAttributionAndWrite } from '@/server/knowledge/attribute';
import { runProposeAndWrite } from '@/server/knowledge/propose';
import { loadTreeSnapshot } from '@/server/knowledge/tree';
import { getR2 } from '@/server/r2';

export const runtime = 'nodejs';

const ImportBlock = z.object({
  block_id: z.string().min(1).optional(),
  source_block_ids: z.array(z.string().min(1)),
  page_spans: z.array(PageSpan).min(1),
  image_refs: z.array(z.string().min(1)),
  final_prompt_md: z.string().min(1),
  final_reference_md: z.string().nullable(),
  final_wrong_answer_md: z.string().min(1),
  knowledge_ids: z.array(z.string().min(1)).min(1),
  cause: z
    .object({
      primary_category: CauseCategory,
      user_notes: z.string().nullable(),
    })
    .nullable(),
  difficulty: z.number().int().min(1).max(5).default(3),
  question_kind: QuestionKind,
});

const ImportBody = z.object({
  blocks: z.array(ImportBlock).min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: sessionId } = await params;
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

    // 1. Validate session exists and is in an importable state
    const sessionRows = await db
      .select()
      .from(ingestion_session)
      .where(eq(ingestion_session.id, sessionId));
    const session = sessionRows[0] ?? null;
    if (!session) {
      throw new ApiError('not_found', `ingestion_session ${sessionId} not found`, 404);
    }
    if (session.status !== 'extracted' && session.status !== 'reviewed') {
      throw new ApiError(
        'conflict',
        `ingestion_session ${sessionId} is in status '${session.status}'; only 'extracted' or 'reviewed' can be imported`,
        409,
      );
    }

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

    // ---- All validation passed; build and execute batch ----
    const now = new Date();

    const directlyImportedIds = new Set<string>();
    for (const b of body.blocks) {
      if (b.block_id !== undefined) directlyImportedIds.add(b.block_id);
    }

    const toIgnore = new Set<string>();

    const questionIds: string[] = [];
    const mistakeIds: string[] = [];
    const queueData: Array<{
      mistakeId: string;
      prompt_md: string;
      reference_md: string | null;
      wrong_answer_md: string;
      knowledge_ids: string[];
      cause: { primary_category: string; user_notes: string | null } | null;
    }> = [];

    for (const block of body.blocks) {
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

        await db.insert(question_block).values({
          id: importedBlockId,
          ingestion_session_id: sessionId,
          source_document_id: session.source_document_id,
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
          imported_mistake_id: null,
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
            .filter((id): id is string => typeof id === 'string' && block.image_refs.includes(id)),
        ),
      ];

      // INSERT question
      const questionId = createId();
      questionIds.push(questionId);
      const questionMetadata = {
        prompt_image_refs: block.image_refs,
        prompt_image_ref_kind: 'source_asset_id',
        source_document_id: session.source_document_id,
        ingestion_session_id: sessionId,
        question_block_id: importedBlockId,
      };
      await db.insert(question).values({
        id: questionId,
        kind: block.question_kind,
        prompt_md: block.final_prompt_md,
        reference_md: block.final_reference_md,
        knowledge_ids: block.knowledge_ids,
        difficulty: block.difficulty,
        source: session.entrypoint,
        variant_depth: 0,
        metadata: questionMetadata,
        created_at: now,
        updated_at: now,
        version: 0,
      });

      // INSERT mistake
      const mistakeId = createId();
      mistakeIds.push(mistakeId);
      const causeJson: z.infer<typeof Cause> | null = block.cause
        ? {
            primary_category: block.cause.primary_category,
            secondary_categories: [],
            ai_analysis_md: '',
            user_notes: block.cause.user_notes,
            user_edited: true,
          }
        : null;
      await db.insert(mistake).values({
        id: mistakeId,
        question_id: questionId,
        wrong_answer_md: block.final_wrong_answer_md,
        knowledge_ids: block.knowledge_ids,
        cause: causeJson,
        wrong_answer_image_refs: wrongAnswerImageRefs,
        source: session.entrypoint,
        variants: [],
        variants_generated_count: 0,
        variants_max: 3,
        status: 'active',
        created_at: now,
        updated_at: now,
        version: 0,
      });

      // UPDATE question_block to set imported_question_id, imported_mistake_id, status
      await db
        .update(question_block)
        .set({
          imported_question_id: questionId,
          imported_mistake_id: mistakeId,
          status: 'imported',
          updated_at: now,
          version: sql`${question_block.version} + 1`,
        })
        .where(eq(question_block.id, importedBlockId));

      queueData.push({
        mistakeId,
        prompt_md: block.final_prompt_md,
        reference_md: block.final_reference_md,
        wrong_answer_md: block.final_wrong_answer_md,
        knowledge_ids: block.knowledge_ids,
        cause: block.cause,
      });
    }

    // Sweep: mark any draft blocks user dropped as 'ignored'
    const sessionDrafts = await db
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

    // UPDATE source blocks → status='ignored'
    for (const sid of toIgnore) {
      await db
        .update(question_block)
        .set({ status: 'ignored', updated_at: now, version: sql`${question_block.version} + 1` })
        .where(eq(question_block.id, sid));
    }

    // UPDATE ingestion_session → status='imported'
    await db
      .update(ingestion_session)
      .set({ status: 'imported', updated_at: now, version: sql`${ingestion_session.version} + 1` })
      .where(eq(ingestion_session.id, sessionId));

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
              const result = await runTask(kind, input, { db, r2 });
              return { text: result.text };
            },
          }).catch((err) => {
            console.error('propose prep failed (mistake unaffected)', err);
          }),
        );
        if (q.cause === null) {
          tasks.push(
            (async () => {
              try {
                const tree = await loadTreeSnapshot(db);
                const pickedNodes = tree.filter((n) => q.knowledge_ids.includes(n.id));
                await runAttributionAndWrite({
                  db,
                  mistakeId: q.mistakeId,
                  expectedVersion: 0,
                  input: {
                    prompt_md: q.prompt_md,
                    reference_md: q.reference_md,
                    wrong_answer_md: q.wrong_answer_md,
                    knowledge_context: pickedNodes.map((n) => ({
                      id: n.id,
                      name: n.name,
                      effective_domain: n.effective_domain,
                    })),
                  },
                  runTaskFn: async (kind, input) => {
                    const result = await runTask(kind, input, { db, r2 });
                    return { text: result.text };
                  },
                });
              } catch (err) {
                console.error('attribution prep failed (mistake unaffected)', err);
              }
            })(),
          );
        }
        return tasks;
      }),
    );

    return Response.json({ question_ids: questionIds, mistake_ids: mistakeIds });
  } catch (err) {
    return errorResponse(err);
  }
}
