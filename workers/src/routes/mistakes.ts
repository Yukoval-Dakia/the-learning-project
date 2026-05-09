import { Hono } from 'hono';
import { z } from 'zod';
import { createId } from '@paralleldrive/cuid2';
import { runTask } from '../ai/runner';
import { runProposeAndWrite } from '../knowledge/propose';
import { CauseCategory, QuestionKind } from '../../../src/core/schema/business';
import type { Bindings } from '../types';

type MistakesEnv = {
  Bindings: Bindings & {
    executionCtx: { waitUntil: (p: Promise<unknown>) => void };
  };
};

export const mistakes = new Hono<MistakesEnv>();

const Body = z.object({
  prompt_md: z.string().min(1, 'prompt_md is required'),
  reference_md: z.string().nullable(),
  wrong_answer_md: z.string().min(1, 'wrong_answer_md is required'),
  knowledge_ids: z.array(z.string().min(1)).min(1, 'at least one knowledge_id is required'),
  cause: z
    .object({
      primary_category: CauseCategory,
      user_notes: z.string().nullable(),
    })
    .nullable(),
  difficulty: z.number().int().min(1).max(5),
  question_kind: QuestionKind,
});

mistakes.post('/', async (c) => {
  const raw = (await c.req.json().catch(() => null)) as unknown;
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: 'validation_error',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
      400,
    );
  }
  const body = parsed.data;

  const missing: string[] = [];
  for (const id of body.knowledge_ids) {
    const row = await c.env.DB.prepare(`select id from knowledge where id = ? and archived_at is null`)
      .bind(id)
      .first();
    if (!row) missing.push(id);
  }
  if (missing.length > 0) {
    return c.json(
      {
        error: 'validation_error',
        message: `unknown or archived knowledge_ids: ${missing.join(', ')}`,
      },
      400,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const questionId = createId();
  const mistakeId = createId();
  const causeJson = body.cause
    ? JSON.stringify({
        primary_category: body.cause.primary_category,
        secondary_categories: [],
        ai_analysis_md: '',
        user_notes: body.cause.user_notes,
        user_edited: true,
      })
    : null;

  const insertQuestion = c.env.DB.prepare(
    `insert into question (
      id, kind, prompt_md, reference_md, knowledge_ids, difficulty,
      source, variant_depth, created_at, updated_at, version
    ) values (?, ?, ?, ?, ?, ?, 'manual', 0, ?, ?, 0)`,
  ).bind(
    questionId,
    body.question_kind,
    body.prompt_md,
    body.reference_md,
    JSON.stringify(body.knowledge_ids),
    body.difficulty,
    now,
    now,
  );
  const insertMistake = c.env.DB.prepare(
    `insert into mistake (
      id, question_id, wrong_answer_md, knowledge_ids, cause,
      wrong_answer_image_refs, source, variants, variants_generated_count, variants_max,
      status, created_at, updated_at, version
    ) values (?, ?, ?, ?, ?, '[]', 'manual', '[]', 0, 3, 'active', ?, ?, 0)`,
  ).bind(
    mistakeId,
    questionId,
    body.wrong_answer_md,
    JSON.stringify(body.knowledge_ids),
    causeJson,
    now,
    now,
  );
  await c.env.DB.batch([insertQuestion, insertMistake]);

  c.env.executionCtx.waitUntil(
    runProposeAndWrite({
      db: c.env.DB,
      mistakeContent: {
        prompt_md: body.prompt_md,
        reference_md: body.reference_md,
        wrong_answer_md: body.wrong_answer_md,
        knowledge_ids_picked: body.knowledge_ids,
      },
      runTaskFn: async (kind, input, ctx) => {
        const result = await runTask(kind, input, ctx as { env: typeof c.env });
        return { text: result.text };
      },
      env: c.env,
    }),
  );

  return c.json({
    question_id: questionId,
    mistake_id: mistakeId,
    propose_task: 'queued' as const,
  });
});
