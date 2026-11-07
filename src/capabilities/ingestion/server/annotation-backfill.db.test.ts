/**
 * YUK-1994 slice 3 — background knowledge/solution annotation invariants.
 *
 * DB-backed; the model seams are injected so no provider runs.
 *
 * @invariant data: a question whose knowledge attribution failed is repaired in the
 *   background, flips its marker to attributed, and a second run neither re-pays nor
 *   rewrites the row.
 * @fails-if a rerun spends another attribution/annotation call, the marker stays
 *   missing after a successful repair, or the solution annotation never persists.
 *
 * @invariant data: a permanently failing phase stops after ANNOTATION_MAX_ATTEMPTS and
 *   stays visibly missing instead of retrying forever.
 * @fails-if a fourth sweep still calls the paid function or the attempt counter is
 *   not persisted.
 *
 * @invariant concurrency: a freshly proposed KC is embedded immediately and a later
 *   question reuses it instead of minting a near-duplicate; normalized-name reuse is
 *   the fallback when the cosine gate misses.
 * @fails-if two questions produce two sibling KCs for one concept.
 *
 * @invariant data: a task run whose model text cannot be parsed is not recorded as
 *   success; it is settled as a failure so observability and retry logic see the truth.
 * @fails-if the ai_task_runs row keeps status='success'.
 *
 * @invariant security: learner text sent to the annotation model is redacted and
 *   receipted, and a document whose derivation policy restricts model use is never
 *   sent at all.
 * @fails-if the provider seam receives the raw prompt, no usage receipt is written,
 *   or an answer_only document's content reaches the model.
 *
 * @invariant data: a metadata-only annotation write keeps a current embedding
 *   current — the vector stays retrievable instead of going revision-stale.
 * @fails-if embed_source_revision lags the bumped version or a stale revision is
 *   re-blessed by metadata churn.
 *
 * @invariant concurrency: paid-call accounting survives CAS contention — a won
 *   write records the attempt, and a lost write still merges the counter back.
 * @fails-if a transient provider refusal consumes the model-attempt budget, or a
 *   billed call whose CAS lost leaves the attempt counter unchanged.
 */
import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRunError } from '@/ai/agent-run-error';
import type { ProviderTransportEvidence } from '@/ai/task-result';
import { EMBED_VERSION, embedHash, knowledgeEmbedText } from '@/core/embed-source';
import { SOLUTION_ANNOTATION_CONTRACT } from '@/core/schema/solution-annotation';
import { embedCurrencyPredicate } from '@/db/embed-currency';
import {
  ai_task_runs,
  event,
  knowledge,
  learning_session,
  question,
  question_block,
  source_document,
} from '@/db/schema';
import { tagKnowledge } from '@/kernel/records/knowledge-tag';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  ANNOTATION_MAX_ATTEMPTS,
  type RunAnnotationBackfillParams,
  runAnnotationBackfill,
} from './annotation-backfill';
import { ColdStartBridgeError, runColdStartBridge } from './cold-start-bridge';
import { SolutionAnnotationPolicyError, generateSolutionAnnotation } from './solution-annotation';

const DIMS = 1024;

function unitVec(i: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[i] = 1;
  return v;
}

async function seedSubjectRoot(db: ReturnType<typeof testDb>): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id: 'seed:physics:root',
    name: '物理',
    domain: 'physics',
    parent_id: null,
    role: 'container',
    approval_status: 'approved',
    merged_from: [],
    proposed_by_ai: false,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedMissingQuestion(db: ReturnType<typeof testDb>): Promise<string> {
  const now = new Date();
  const id = createId();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: '一条形磁铁穿过线圈时，感应电流方向如何判断？',
    knowledge_ids: [],
    difficulty: 3,
    source: 'vision_paper',
    draft_status: 'active',
    metadata: {
      ingestion_session_id: 'sess_1',
      ingestion_enrollment: { knowledge: 'missing', solution: 'missing' },
    },
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

function backfillParams(
  db: ReturnType<typeof testDb>,
  questionId: string,
  overrides: Partial<RunAnnotationBackfillParams> = {},
): RunAnnotationBackfillParams {
  return { db, questionIds: [questionId], ...overrides };
}

beforeEach(async () => {
  await resetDb();
});

describe('runAnnotationBackfill', () => {
  // @invariant data: a missing knowledge/solution label is repaired to attributed/annotated and a rerun neither re-pays nor rewrites the row
  // @fails-if the marker stays missing, the annotation never persists, or a second sweep calls the paid seam again
  it('repairs knowledge + solution once, then a rerun is a no-op', async () => {
    const db = testDb();
    const questionId = await seedMissingQuestion(db);
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k_lc',
      name: '楞次定律',
      domain: 'physics',
      parent_id: null,
      role: 'kc',
      approval_status: 'approved',
      merged_from: [],
      proposed_by_ai: false,
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const attributeFn = vi.fn(async () => ({ knowledgeIds: ['k_lc'] }));
    const annotateFn = vi.fn(async () => ({
      contract: SOLUTION_ANNOTATION_CONTRACT,
      method_md: '用楞次定律判断感应电流方向',
      steps_md: ['明确原磁场方向', '判断磁通量变化', '由楞次定律定感应电流方向'],
      confidence: 0.9,
      task_run_id: null,
      provider: 'stub',
      model: 'stub',
      generated_at: now.toISOString(),
    }));

    const first = await runAnnotationBackfill(
      backfillParams(db, questionId, { attributeFn, annotateFn }),
    );
    expect(first).toMatchObject({
      scanned: 1,
      knowledge_filled: 1,
      solution_filled: 1,
      knowledge_failed: 0,
      solution_failed: 0,
    });
    expect(attributeFn).toHaveBeenCalledTimes(1);
    expect(annotateFn).toHaveBeenCalledTimes(1);

    const [row] = await db.select().from(question).where(eq(question.id, questionId));
    expect(row?.knowledge_ids).toEqual(['k_lc']);
    expect(row?.metadata).toMatchObject({
      ingestion_enrollment: {
        knowledge: 'attributed',
        solution: 'annotated',
        knowledge_attempts: 1,
        solution_attempts: 1,
      },
    });
    expect(row?.metadata?.solution_annotation).toMatchObject({
      method_md: '用楞次定律判断感应电流方向',
    });

    const second = await runAnnotationBackfill({ db });
    expect(second.knowledge_filled).toBe(0);
    expect(second.solution_filled).toBe(0);
    // A global sweep must not re-select a fully labelled row.
    expect(second.scanned).toBe(0);
    // No second paid call for a row that is already whole.
    expect(attributeFn).toHaveBeenCalledTimes(1);
    expect(annotateFn).toHaveBeenCalledTimes(1);
    const [after] = await db.select().from(question).where(eq(question.id, questionId));
    expect(after?.version).toBe(row?.version);
  });

  // @invariant data: a permanently failing annotation phase stops at the attempt cap and stays visibly missing instead of retrying forever
  // @fails-if a later sweep still calls the paid seam or the attempt counter is not persisted
  it('stops a permanently failing phase at the attempt cap', async () => {
    const db = testDb();
    const questionId = await seedMissingQuestion(db);
    const attributeFn = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const annotateFn = vi.fn(async () => {
      throw new Error('provider unavailable');
    });

    for (let run = 0; run < ANNOTATION_MAX_ATTEMPTS; run += 1) {
      await runAnnotationBackfill(backfillParams(db, questionId, { attributeFn, annotateFn }));
    }
    expect(attributeFn).toHaveBeenCalledTimes(ANNOTATION_MAX_ATTEMPTS);
    expect(annotateFn).toHaveBeenCalledTimes(ANNOTATION_MAX_ATTEMPTS);

    // The global sweep is the durable owner; a capped row must never be selected again.
    const capped = await runAnnotationBackfill({ db });
    // The cap is the money guard: no further paid attempt, the row reports exhausted.
    expect(capped.scanned).toBe(0);
    expect(attributeFn).toHaveBeenCalledTimes(ANNOTATION_MAX_ATTEMPTS);
    expect(annotateFn).toHaveBeenCalledTimes(ANNOTATION_MAX_ATTEMPTS);

    const [row] = await db.select().from(question).where(eq(question.id, questionId));
    expect(row?.metadata).toMatchObject({
      ingestion_enrollment: {
        knowledge: 'missing',
        solution: 'missing',
        knowledge_attempts: ANNOTATION_MAX_ATTEMPTS,
        solution_attempts: ANNOTATION_MAX_ATTEMPTS,
      },
    });
  });
});

describe('tagKnowledge duplicate prevention', () => {
  // @invariant concurrency: a newly proposed KC is matchable immediately, so a sibling question reuses it instead of minting a near-duplicate
  // @fails-if the freshly created node has no embedding or the second question creates a second sibling KC
  it('embeds a proposed KC immediately so the next question matches it', async () => {
    const db = testDb();
    await seedSubjectRoot(db);
    const seenVectors: number[][] = [];
    const embedder = {
      provider: 'stub',
      model: 'stub-embed',
      embed: async () => {
        const v = unitVec(0);
        seenVectors.push(v);
        return v;
      },
    };
    const nameKcFn = vi.fn(async () => ({ kc_name: '楞次定律' }));

    const first = await tagKnowledge(
      { db, embedder, nameKcFn },
      {
        questionText: '闭合回路中磁通量增大时，感应电流的磁场方向如何？',
        subjectRootId: 'seed:physics:root',
      },
    );
    expect(first.kind).toBe('propose');
    const [created] = await db
      .select()
      .from(knowledge)
      .where(and(eq(knowledge.parent_id, 'seed:physics:root'), isNull(knowledge.archived_at)));
    expect(created?.embedding).not.toBeNull();
    expect(created?.embed_version).toBe(EMBED_VERSION);
    const expectedHash = embedHash(
      knowledgeEmbedText({ name: '楞次定律', effectiveDomain: 'physics' }),
    );
    expect(created?.embed_content_hash).toBe(expectedHash);

    const second = await tagKnowledge(
      { db, embedder, nameKcFn },
      {
        questionText: '根据楞次定律，判断线圈中感应电流的方向。',
        subjectRootId: 'seed:physics:root',
      },
    );
    expect(second.kind).toBe('match');
    expect(second.knowledge_ids).toEqual([created?.id]);
    // One concept, one node — no near-duplicate sibling.
    const leaves = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(eq(knowledge.parent_id, 'seed:physics:root'), isNull(knowledge.archived_at)));
    expect(leaves).toHaveLength(1);
    expect(seenVectors.length).toBeGreaterThanOrEqual(3); // question, KC stamp, question
  });

  // @invariant concurrency: normalized-name reuse prevents a punctuation-only re-proposal from minting a duplicate sibling
  // @fails-if the second attribution creates a second KC under the subject root
  it('reuses a same-named KC when the cosine gate misses', async () => {
    const db = testDb();
    await seedSubjectRoot(db);
    let vector = unitVec(0);
    const embedder = {
      provider: 'stub',
      model: 'stub-embed',
      embed: async () => vector,
    };
    const nameKcFn = vi.fn(async () => ({ kc_name: '楞次定律' }));

    const first = await tagKnowledge(
      { db, embedder, nameKcFn },
      { questionText: '第一道题', subjectRootId: 'seed:physics:root' },
    );
    expect(first.kind).toBe('propose');
    const firstId = first.knowledge_ids[0];

    // Force the cosine gate to miss, then propose the same name with punctuation drift.
    vector = unitVec(1);
    const second = await tagKnowledge(
      { db, embedder, nameKcFn: async () => ({ kc_name: ' 楞次定律。' }) },
      { questionText: '第二道题', subjectRootId: 'seed:physics:root' },
    );
    expect(second.knowledge_ids).toEqual([firstId]);
    const leaves = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(eq(knowledge.parent_id, 'seed:physics:root'), isNull(knowledge.archived_at)));
    expect(leaves).toHaveLength(1);
  });
});

describe('AI-boundary privacy', () => {
  async function seedIngestedQuestion(
    db: ReturnType<typeof testDb>,
    input: { policy: 'allow' | 'answer_only'; promptMd: string },
  ): Promise<{ questionId: string; sessionId: string; documentId: string }> {
    const now = new Date();
    const documentId = createId();
    const sessionId = createId();
    const blockId = createId();
    const questionId = createId();
    await db.insert(source_document).values({
      id: documentId,
      source_asset_ids: ['asset_1'],
      provenance: { usage_policy: { derivation_policy: input.policy } },
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(learning_session).values({
      id: sessionId,
      type: 'ingestion',
      status: 'extracted',
      source_document_id: documentId,
      source_asset_ids: ['asset_1'],
      entrypoint: 'vision_paper',
      warnings: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(question_block).values({
      id: blockId,
      ingestion_session_id: sessionId,
      source_document_id: documentId,
      source_asset_ids: ['asset_1'],
      page_spans: [],
      figures: [],
      image_refs: ['asset_1'],
      status: 'auto_enrolled',
      knowledge_hint: '二次函数',
      merged_from_block_ids: [],
      imported_question_id: questionId,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(question).values({
      id: questionId,
      kind: 'short_answer',
      prompt_md: input.promptMd,
      knowledge_ids: [],
      difficulty: 3,
      source: 'vision_paper',
      draft_status: 'active',
      metadata: {
        source_document_id: documentId,
        ingestion_session_id: sessionId,
        question_block_id: blockId,
        ingestion_enrollment: { knowledge: 'attributed', solution: 'missing' },
      },
      created_at: now,
      updated_at: now,
      version: 0,
    });
    return { questionId, sessionId, documentId };
  }

  // @invariant security: the model only ever sees the redacted prompt, every send writes a policy-bound usage receipt, and an answer_only document is never sent
  // @fails-if the raw prompt reaches the provider seam, the receipt is missing/unbound, or the restricted document's content is sent
  it('sends only redacted text with a usage receipt; a restricted document is never sent', async () => {
    const db = testDb();
    const allowed = await seedIngestedQuestion(db, {
      policy: 'allow',
      promptMd: '姓名：张倩 考号：G2023001 求函数 f(x)=x²-2x+1 的最小值。',
    });
    const restricted = await seedIngestedQuestion(db, {
      policy: 'answer_only',
      promptMd: '姓名：李蕾 考号：G2023002 求该函数的零点。',
    });

    const seenInputs: unknown[] = [];
    const runTaskFn = vi.fn(async (_kind: string, input: unknown) => {
      seenInputs.push(input);
      return { text: '{"method_md":"配方法求最值","steps_md":["化为顶点式"],"confidence":0.8}' };
    });
    // Real entry: only the provider seam is substituted.
    const annotateFn = (p: Parameters<typeof generateSolutionAnnotation>[0]) =>
      generateSolutionAnnotation({ ...p, runTaskFn });

    const result = await runAnnotationBackfill({
      db,
      questionIds: [allowed.questionId, restricted.questionId],
      annotateFn,
    });

    expect(result.solution_filled).toBe(1);
    expect(result.policy_blocked).toBe(1);
    // Exactly one send happened — the allowed document only.
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    const sent = seenInputs[0] as { prompt_md: string };
    expect(sent.prompt_md).not.toContain('张倩');
    expect(sent.prompt_md).not.toContain('G2023001');
    expect(sent.prompt_md).toContain('[已隐去]');

    const [annotated] = await db.select().from(question).where(eq(question.id, allowed.questionId));
    expect(annotated?.metadata).toMatchObject({
      ingestion_enrollment: { solution: 'annotated' },
      solution_annotation: { method_md: '配方法求最值' },
    });

    const [blocked] = await db
      .select()
      .from(question)
      .where(eq(question.id, restricted.questionId));
    const blockedEnrollment = ((blocked?.metadata ?? {}) as Record<string, unknown>)
      .ingestion_enrollment as Record<string, unknown>;
    expect(blockedEnrollment.solution).toBe('missing');
    expect(blockedEnrollment.solution_last_error).toBe('usage_policy_restricted');
    expect(blockedEnrollment.solution_attempts).toBeUndefined();

    const receipts = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:ingestion_usage_receipt'));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      session_id: allowed.sessionId,
      subject_id: allowed.documentId,
    });
    expect(receipts[0]?.payload).toMatchObject({
      derivation_policy: 'allow',
      engine: 'ingestion_solution_annotation',
      channels: { page_images: 'none', extracted_text: 'redacted' },
    });
    const fields = ((receipts[0]?.payload ?? {}) as Record<string, unknown>)
      .redacted_fields as string[];
    expect(fields).toEqual(expect.arrayContaining(['labeled_identity', 'id_number']));

    // The boundary gate itself: a direct call with restricted usage rejects
    // before any send, even if the sweep gate were bypassed.
    await expect(
      generateSolutionAnnotation({
        db,
        promptMd: '姓名：李蕾 考号：G2023002 求该函数的零点。',
        kind: 'short_answer',
        knowledgeLabel: null,
        usage: {
          sessionId: restricted.sessionId,
          sourceDocumentId: restricted.documentId,
        },
        runTaskFn,
      }),
    ).rejects.toBeInstanceOf(SolutionAnnotationPolicyError);
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });
});

describe('embed currency on metadata-only writes', () => {
  // @invariant data: the annotation write keeps a current vector current and never re-blesses a stale one
  // @fails-if the stored revision lags the version bump after repair, or a stale revision is carried forward
  it('carries embed_source_revision across the annotation write', async () => {
    const db = testDb();
    const annotateFn = vi.fn(async () => ({
      contract: SOLUTION_ANNOTATION_CONTRACT,
      method_md: '一种解法',
      steps_md: ['一步'],
      confidence: 0.9,
      task_run_id: null,
      provider: 'stub',
      model: 'stub',
      generated_at: new Date().toISOString(),
    }));

    const currency = embedCurrencyPredicate({
      version: question.version,
      embed_version: question.embed_version,
      embed_source_revision: question.embed_source_revision,
    });
    const retrievable = async (id: string) =>
      (
        await db
          .select({ id: question.id })
          .from(question)
          .where(and(eq(question.id, id), sql`${question.embedding} IS NOT NULL`, currency))
      ).length === 1;

    // Row A: vector stamped from the current revision — must stay retrievable.
    const currentId = createId();
    await db.insert(question).values({
      id: currentId,
      kind: 'short_answer',
      prompt_md: '一条形磁铁穿过线圈时，感应电流方向如何判断？',
      knowledge_ids: [],
      difficulty: 3,
      source: 'vision_paper',
      draft_status: 'active',
      metadata: {
        ingestion_session_id: 'sess_1',
        ingestion_enrollment: { knowledge: 'attributed', solution: 'missing' },
      },
      embedding: unitVec(0),
      embed_version: EMBED_VERSION,
      embed_source_revision: 0,
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    expect(await retrievable(currentId)).toBe(true);

    // Row B: already stale (vector predates two edits) — metadata churn must not
    // re-bless it.
    const staleId = createId();
    await db.insert(question).values({
      id: staleId,
      kind: 'short_answer',
      prompt_md: '一条形磁铁穿过线圈时，感应电流方向如何判断？',
      knowledge_ids: [],
      difficulty: 3,
      source: 'vision_paper',
      draft_status: 'active',
      metadata: {
        ingestion_session_id: 'sess_1',
        ingestion_enrollment: { knowledge: 'attributed', solution: 'missing' },
      },
      embedding: unitVec(0),
      embed_version: EMBED_VERSION,
      embed_source_revision: 0,
      created_at: new Date(),
      updated_at: new Date(),
      version: 2,
    });
    expect(await retrievable(staleId)).toBe(false);

    await runAnnotationBackfill({
      db,
      questionIds: [currentId, staleId],
      annotateFn,
    });
    expect(annotateFn).toHaveBeenCalledTimes(2);

    expect(await retrievable(currentId)).toBe(true);
    expect(await retrievable(staleId)).toBe(false);
    const [a] = await db.select().from(question).where(eq(question.id, currentId));
    expect(a?.embed_source_revision).toBe(a?.version);
  });
});

describe('sweep scope and retry accounting', () => {
  // @invariant data: the cron sweep only spends on post-slice-3 enrollments — pre-marker inventory and drafts are out of reach of the paid path
  // @fails-if a global sweep selects a legacy marker row or a draft question
  it('selects only marker-carrying non-draft rows in the global sweep', async () => {
    const db = testDb();
    const now = new Date();
    const mk = async (id: string, metadata: Record<string, unknown>, draft: string) =>
      db.insert(question).values({
        id,
        kind: 'short_answer',
        prompt_md: '一条形磁铁穿过线圈时，感应电流方向如何判断？',
        knowledge_ids: [],
        difficulty: 3,
        source: 'vision_paper',
        draft_status: draft,
        // A session anchor is what resolves policy to 'allow' here; unanchored
        // rows fail closed by design.
        metadata: { ingestion_session_id: 'sess_1', ...metadata },
        created_at: now,
        updated_at: now,
        version: 0,
      });
    // Pre-slice-3 inventory: enrolled before the `solution` marker existed.
    await mk(createId(), { ingestion_enrollment: { knowledge: 'missing' } }, 'active');
    // A draft that carries the new marker is still not a paid target.
    await mk(
      createId(),
      { ingestion_enrollment: { knowledge: 'missing', solution: 'missing' } },
      'draft',
    );
    // The only eligible row.
    const eligible = createId();
    await mk(
      eligible,
      { ingestion_enrollment: { knowledge: 'attributed', solution: 'missing' } },
      'active',
    );

    const annotateFn = vi.fn(async () => ({
      contract: SOLUTION_ANNOTATION_CONTRACT,
      method_md: '一种解法',
      steps_md: ['一步'],
      confidence: 0.9,
      task_run_id: null,
      provider: 'stub',
      model: 'stub',
      generated_at: new Date().toISOString(),
    }));
    const attributeFn = vi.fn(async () => ({ knowledgeIds: [] }));

    const result = await runAnnotationBackfill({ db, annotateFn, attributeFn });
    expect(result.scanned).toBe(1);
    expect(annotateFn).toHaveBeenCalledTimes(1);
    expect(attributeFn).not.toHaveBeenCalled();
  });

  // @invariant concurrency: a provably unbilled provider refusal never consumes the paid attempt budget, while a billed call whose CAS lost is still counted once
  // @fails-if a 5xx burns a model attempt, or the CAS-loss merge leaves attempts unchanged
  it('transient refusals keep the paid budget; a CAS-lost paid call still counts once', async () => {
    const db = testDb();
    const now = new Date();
    const transientId = createId();
    const contendedId = createId();
    const seed = async (id: string, prompt: string) =>
      db.insert(question).values({
        id,
        kind: 'short_answer',
        prompt_md: prompt,
        knowledge_ids: [],
        difficulty: 3,
        source: 'vision_paper',
        draft_status: 'active',
        metadata: {
          ingestion_session_id: 'sess_1',
          ingestion_enrollment: { knowledge: 'attributed', solution: 'missing' },
        },
        created_at: now,
        updated_at: now,
        version: 0,
      });
    await seed(transientId, 'transient 行题面：一条形磁铁穿过线圈时感应电流方向如何判断？');
    await seed(contendedId, 'contended 行题面：求二次函数最小值。');

    const annotateFn = vi.fn(async (p: { db: unknown; promptMd: string }) => {
      if (p.promptMd === 'transient 行题面：一条形磁铁穿过线圈时感应电流方向如何判断？') {
        // Provably-unbilled provider refusal: a bound 5xx.
        throw new AgentRunError({
          kind: 'IngestionSolutionAnnotationTask',
          taskRunId: 'tr_stub',
          subtype: 'api_error_result',
          apiErrorStatus: 502,
          errors: ['bad gateway'],
        });
      }
      // Simulate a concurrent editor winning the CAS between select and write.
      await db
        .update(question)
        .set({ version: sql`${question.version} + 1` })
        .where(eq(question.id, contendedId));
      return {
        contract: SOLUTION_ANNOTATION_CONTRACT,
        method_md: '一种解法',
        steps_md: ['一步'],
        confidence: 0.9,
        task_run_id: null,
        provider: 'stub',
        model: 'stub',
        generated_at: now.toISOString(),
      };
    });

    await runAnnotationBackfill({
      db,
      questionIds: [transientId, contendedId],
      annotateFn,
    });
    expect(annotateFn).toHaveBeenCalledTimes(2);

    const enrollmentOf = async (id: string) => {
      const [row] = await db.select().from(question).where(eq(question.id, id));
      return ((row?.metadata ?? {}) as Record<string, unknown>).ingestion_enrollment as Record<
        string,
        unknown
      >;
    };

    // Unbilled refusal: infra counter moved, paid budget untouched, still missing.
    const transient = await enrollmentOf(transientId);
    expect(transient.solution).toBe('missing');
    expect(transient.solution_infra_failures).toBe(1);
    expect(transient.solution_attempts).toBeUndefined();

    // Billed call whose write lost: the attempt is merged back — paid once, so
    // counted once, and the row stays eligible for the next sweep.
    const contended = await enrollmentOf(contendedId);
    expect(contended.solution).toBe('missing');
    expect(contended.solution_attempts).toBe(1);
    expect(contended.solution_last_error).toBe('write_contended_after_paid_call');
  });
});

describe('figure-dependent questions', () => {
  // @invariant data: a question whose text cannot carry it without its figure is marked skipped, never annotated from partial text
  // @fails-if the text-only task produces an annotation for a figure-dependent question
  it('marks a figure-dependent question skipped instead of annotating from partial text', async () => {
    const db = testDb();
    const questionId = createId();
    await db.insert(question).values({
      id: questionId,
      kind: 'short_answer',
      prompt_md: '见图',
      knowledge_ids: [],
      difficulty: 3,
      source: 'vision_paper',
      draft_status: 'active',
      metadata: {
        ingestion_session_id: 'sess_1',
        ingestion_enrollment: { knowledge: 'attributed', solution: 'missing' },
      },
      figures: [
        {
          asset_id: 'asset_fig',
          role: 'diagram',
          source_page_index: 0,
          source_bbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
          attached_to_index: 'root',
          attach_confidence: 'high',
        },
      ],
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });

    const annotateFn = vi.fn();
    const result = await runAnnotationBackfill({ db, questionIds: [questionId], annotateFn });
    expect(annotateFn).not.toHaveBeenCalled();
    expect(result.solution_filled).toBe(0);

    const [row] = await db.select().from(question).where(eq(question.id, questionId));
    expect(row?.metadata).toMatchObject({
      ingestion_enrollment: {
        solution: 'skipped',
        solution_skipped_reason: 'figure_dependent',
      },
    });
    // Terminal: the sweep never selects a skipped row again.
    const sweep = await runAnnotationBackfill({ db, annotateFn });
    expect(sweep.scanned).toBe(0);
  });
});

describe('invalid task output settlement', () => {
  // @invariant data: an unparseable model output settles the task run as failure, not success
  // @fails-if the ai_task_runs row keeps status='success' after the parse failure
  it('does not leave an unparseable bridge run recorded as success', async () => {
    const db = testDb();
    const taskRunId = createId();
    await db.insert(ai_task_runs).values({
      id: taskRunId,
      task_kind: 'ColdStartPlacementBridgeTask',
      provider: 'stub',
      model: 'stub',
      input_hash: 'hash',
      status: 'success',
      finish_reason: 'stop',
      started_at: new Date(),
      finished_at: new Date(),
    });

    await expect(
      runColdStartBridge({
        db,
        questionMd: '一道题',
        existingReferenceMd: null,
        knowledgeHint: null,
        knownSubjects: [{ id: 'physics', display_name: '物理' }],
        runTaskFn: async () => ({ text: 'this is not json', task_run_id: taskRunId }),
      }),
    ).rejects.toBeInstanceOf(ColdStartBridgeError);

    const [run] = await db.select().from(ai_task_runs).where(eq(ai_task_runs.id, taskRunId));
    expect(run?.status).toBe('failure');
    expect(run?.finish_reason).toBe('model_output_invalid');
  });
});

describe('infra transport evidence and backoff', () => {
  const enrollmentOf = async (db: ReturnType<typeof testDb>, id: string) => {
    const [row] = await db.select().from(question).where(eq(question.id, id));
    return ((row?.metadata ?? {}) as Record<string, unknown>).ingestion_enrollment as Record<
      string,
      unknown
    >;
  };

  const mkQuestion = async (db: ReturnType<typeof testDb>, enrollment: Record<string, unknown>) => {
    const id = createId();
    await db.insert(question).values({
      id,
      kind: 'short_answer',
      // The id suffix lets the stub annotateFn pick this row's task-run error.
      prompt_md: `infra 行题面：计算圆的面积公式。${id}`,
      knowledge_ids: [],
      difficulty: 3,
      source: 'vision_paper',
      draft_status: 'active',
      metadata: {
        ingestion_session_id: 'sess_1',
        ingestion_enrollment: { knowledge: 'attributed', solution: 'missing', ...enrollment },
      },
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
    return id;
  };

  const transportEvidence = (
    sendState: 'not_sent' | 'sent_without_response',
  ): ProviderTransportEvidence => ({
    v: 1,
    budget: { task_timeout_ms: 180_000 },
    lane: 'undici_agent',
    send_state: sendState,
    totals: {
      requests: 1,
      dispatches: 1,
      by_state: {
        not_sent: sendState === 'not_sent' ? 1 : 0,
        sent_without_response: sendState === 'sent_without_response' ? 1 : 0,
        response_received: 0,
        unknown: 0,
        in_flight: 0,
      },
    },
    requests: [
      {
        seq: 1,
        loop: 'root',
        lane: 'undici_agent',
        fetch_invoked_at: new Date().toISOString(),
        send_state: sendState,
      },
    ],
    requests_seen: 1,
    requests_dropped: 0,
    captured_at: new Date().toISOString(),
  });

  const seedFailedRun = async (
    db: ReturnType<typeof testDb>,
    transport: ProviderTransportEvidence,
  ) => {
    const taskRunId = createId();
    await db.insert(ai_task_runs).values({
      id: taskRunId,
      task_kind: 'IngestionSolutionAnnotationTask',
      provider: 'stub',
      model: 'stub',
      input_hash: 'hash',
      status: 'failure',
      finish_reason: 'provider_error',
      started_at: new Date(),
      finished_at: new Date(),
      usage_json: { inputTokens: 0, outputTokens: 0, transport },
    });
    return taskRunId;
  };

  // @invariant concurrency: only positively-evidenced unbilled failures spare the
  //   paid budget — a settled not_sent wire is infra, while a send whose
  //   disposition is unknown still counts as a paid attempt
  // @fails-if a sent_without_response transport escapes the attempt counter, or a
  //   proven not_sent failure consumes it
  it('not_sent transport is infra; sent_without_response still pays an attempt', async () => {
    const db = testDb();
    const notSentRunId = await seedFailedRun(db, transportEvidence('not_sent'));
    const uncertainRunId = await seedFailedRun(db, transportEvidence('sent_without_response'));
    const notSentQ = await mkQuestion(db, {});
    const uncertainQ = await mkQuestion(db, {});

    const annotateFn = vi.fn(async (p: { promptMd: string }) => {
      const taskRunId = p.promptMd.endsWith(notSentQ) ? notSentRunId : uncertainRunId;
      // Connection-class failure: no bound status, transport is the only proof.
      throw new AgentRunError({
        kind: 'IngestionSolutionAnnotationTask',
        taskRunId,
        subtype: 'api_error_result',
        apiErrorStatus: null,
        errors: ['connect ECONNREFUSED'],
      });
    });
    await runAnnotationBackfill({ db, questionIds: [notSentQ, uncertainQ], annotateFn });

    const notSent = await enrollmentOf(db, notSentQ);
    expect(notSent.solution_infra_failures).toBe(1);
    expect(notSent.solution_attempts).toBeUndefined();

    const uncertain = await enrollmentOf(db, uncertainQ);
    expect(uncertain.solution_infra_failures).toBeUndefined();
    expect(uncertain.solution_attempts).toBe(1);
  });

  // @invariant concurrency: after the burst budget a downed lane stops being
  //   retried every sweep — the next resend is scheduled ≈ +4h instead
  // @fails-if the thirteenth infra failure leaves the row eligible for the next
  //   sweep, or no next_at is scheduled
  it('past the burst budget a refusal schedules the next resend ≈ +4h', async () => {
    const db = testDb();
    const runId = await seedFailedRun(db, transportEvidence('not_sent'));
    const questionId = await mkQuestion(db, { solution_infra_failures: 12 });
    const now = new Date('2026-01-01T00:00:00Z');

    await runAnnotationBackfill({
      db,
      questionIds: [questionId],
      now,
      annotateFn: async () => {
        throw new AgentRunError({
          kind: 'IngestionSolutionAnnotationTask',
          taskRunId: runId,
          subtype: 'api_error_result',
          apiErrorStatus: null,
          errors: ['connect ECONNREFUSED'],
        });
      },
    });

    const enrollment = await enrollmentOf(db, questionId);
    expect(enrollment.solution_infra_failures).toBe(13);
    expect(enrollment.solution_attempts).toBeUndefined();
    const nextAt = new Date(enrollment.solution_infra_next_at as string).getTime();
    expect(nextAt).toBe(now.getTime() + 4 * 60 * 60 * 1000);

    // The sweep honors the timestamp: an hour later the row still waits.
    const early = await runAnnotationBackfill({
      db,
      now: new Date(now.getTime() + 60 * 60 * 1000),
      annotateFn: vi.fn(),
    });
    expect(early.scanned).toBe(0);
    // And it becomes eligible again once the timestamp passes.
    const later = await runAnnotationBackfill({
      db,
      questionIds: [questionId],
      now: new Date(now.getTime() + 5 * 60 * 60 * 1000),
      annotateFn: async () => {
        throw new AgentRunError({
          kind: 'IngestionSolutionAnnotationTask',
          taskRunId: runId,
          subtype: 'api_error_result',
          apiErrorStatus: null,
          errors: ['connect ECONNREFUSED'],
        });
      },
    });
    expect(later.scanned).toBe(1);
    expect(later.infra_failures).toBe(1);
  });

  // @invariant concurrency: a quota_exhausted refusal always waits at least four
  //   hours — an account-level refusal is never re-polled at sweep cadence
  // @fails-if a quota refusal is retried on the next sweep or burns a paid attempt
  it('quota_exhausted waits at least four hours from the first refusal', async () => {
    const db = testDb();
    const questionId = await mkQuestion(db, {});
    const now = new Date('2026-01-02T00:00:00Z');

    await runAnnotationBackfill({
      db,
      questionIds: [questionId],
      now,
      annotateFn: async () => {
        // No seeded ai_task_runs row: the bound 429 + the provider's own quota
        // signature carry the verdict without transport evidence.
        throw new AgentRunError({
          kind: 'IngestionSolutionAnnotationTask',
          taskRunId: 'tr_quota',
          subtype: 'api_error_result',
          apiErrorStatus: 429,
          errors: ['GoUsageLimitError'],
        });
      },
    });

    const enrollment = await enrollmentOf(db, questionId);
    expect(enrollment.solution_infra_failures).toBe(1);
    expect(enrollment.solution_attempts).toBeUndefined();
    const nextAt = new Date(enrollment.solution_infra_next_at as string).getTime();
    expect(nextAt).toBe(now.getTime() + 4 * 60 * 60 * 1000);
  });
});
