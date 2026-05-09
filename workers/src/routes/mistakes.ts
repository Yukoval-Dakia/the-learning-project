import { Hono } from 'hono';
import { z } from 'zod';
import { createId } from '@paralleldrive/cuid2';
import { runTask } from '../ai/runner';
import { runProposeAndWrite } from '../knowledge/propose';
import { runAttributionAndWrite } from '../knowledge/attribute';
import { loadTreeSnapshot } from '../knowledge/tree';
import { CauseCategory, QuestionKind } from '../../../src/core/schema/business';
import type { AppEnv } from '../types';

export const mistakes = new Hono<AppEnv>();

const TOTAL_IMAGE_BYTES_LIMIT = 800_000;

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
  prompt_image_refs: z.array(z.string().min(1)).default([]),
  wrong_answer_image_refs: z.array(z.string().min(1)).default([]),
});

mistakes.get('/recent', async (c) => {
  const limitRaw = c.req.query('limit');
  const limitParsed = limitRaw ? parseInt(limitRaw, 10) : 20;
  const limit = Math.min(Math.max(isNaN(limitParsed) ? 20 : limitParsed, 1), 100);
  const rows = await c.env.DB.prepare(
    `select m.id, m.question_id, m.knowledge_ids, m.cause, m.created_at, q.prompt_md, m.wrong_answer_md from mistake m join question q on q.id = m.question_id where m.archived_at is null and m.deleted_at is null order by m.created_at desc limit ?`,
  )
    .bind(limit)
    .all<{
      id: string;
      question_id: string;
      knowledge_ids: string;
      cause: string | null;
      created_at: number;
      prompt_md: string;
      wrong_answer_md: string;
    }>();
  const out = rows.results.map((r) => ({
    id: r.id,
    question_id: r.question_id,
    prompt_md: r.prompt_md.slice(0, 200),
    wrong_answer_md: r.wrong_answer_md.slice(0, 200),
    knowledge_ids: JSON.parse(r.knowledge_ids) as string[],
    cause: r.cause ? JSON.parse(r.cause) : null,
    created_at: r.created_at,
  }));
  return c.json({ rows: out });
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

  const promptImageBytes = body.prompt_image_refs.reduce((sum, s) => sum + s.length, 0);
  if (promptImageBytes > TOTAL_IMAGE_BYTES_LIMIT) {
    return c.json(
      {
        error: 'validation_error',
        message: `prompt_image_refs total ${promptImageBytes} bytes exceeds ${TOTAL_IMAGE_BYTES_LIMIT} (D1 cell ~1MB limit)`,
      },
      400,
    );
  }
  const wrongAnswerImageBytes = body.wrong_answer_image_refs.reduce((sum, s) => sum + s.length, 0);
  if (wrongAnswerImageBytes > TOTAL_IMAGE_BYTES_LIMIT) {
    return c.json(
      {
        error: 'validation_error',
        message: `wrong_answer_image_refs total ${wrongAnswerImageBytes} bytes exceeds ${TOTAL_IMAGE_BYTES_LIMIT} (D1 cell ~1MB limit)`,
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

  const questionMetadata =
    body.prompt_image_refs.length > 0
      ? JSON.stringify({ prompt_image_refs: body.prompt_image_refs })
      : null;
  const insertQuestion = c.env.DB.prepare(
    `insert into question (
      id, kind, prompt_md, reference_md, knowledge_ids, difficulty,
      source, variant_depth, metadata, created_at, updated_at, version
    ) values (?, ?, ?, ?, ?, ?, 'manual', 0, ?, ?, ?, 0)`,
  ).bind(
    questionId,
    body.question_kind,
    body.prompt_md,
    body.reference_md,
    JSON.stringify(body.knowledge_ids),
    body.difficulty,
    questionMetadata,
    now,
    now,
  );
  const insertMistake = c.env.DB.prepare(
    `insert into mistake (
      id, question_id, wrong_answer_md, knowledge_ids, cause,
      wrong_answer_image_refs, source, variants, variants_generated_count, variants_max,
      status, created_at, updated_at, version
    ) values (?, ?, ?, ?, ?, ?, 'manual', '[]', 0, 3, 'active', ?, ?, 0)`,
  ).bind(
    mistakeId,
    questionId,
    body.wrong_answer_md,
    JSON.stringify(body.knowledge_ids),
    causeJson,
    JSON.stringify(body.wrong_answer_image_refs),
    now,
    now,
  );
  await c.env.DB.batch([insertQuestion, insertMistake]);

  c.executionCtx.waitUntil(
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

  if (body.cause === null) {
    const tree = await loadTreeSnapshot(c.env.DB);
    const pickedNodes = tree.filter((n) => body.knowledge_ids.includes(n.id));
    c.executionCtx.waitUntil(
      runAttributionAndWrite({
        db: c.env.DB,
        mistakeId,
        expectedVersion: 0,
        input: {
          prompt_md: body.prompt_md,
          reference_md: body.reference_md,
          wrong_answer_md: body.wrong_answer_md,
          knowledge_context: pickedNodes.map((n) => ({
            id: n.id,
            name: n.name,
            effective_domain: n.effective_domain,
          })),
        },
        runTaskFn: async (kind, input, ctx) => {
          const result = await runTask(kind, input, ctx as { env: typeof c.env });
          return { text: result.text };
        },
        env: c.env,
      }),
    );
  }

  return c.json({
    question_id: questionId,
    mistake_id: mistakeId,
    propose_task: 'queued' as const,
  });
});
