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
 */
import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EMBED_VERSION, embedHash, knowledgeEmbedText } from '@/core/embed-source';
import { SOLUTION_ANNOTATION_CONTRACT } from '@/core/schema/solution-annotation';
import { ai_task_runs, knowledge, question } from '@/db/schema';
import { tagKnowledge } from '@/kernel/records/knowledge-tag';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  ANNOTATION_MAX_ATTEMPTS,
  type RunAnnotationBackfillParams,
  runAnnotationBackfill,
} from './annotation-backfill';
import { ColdStartBridgeError, runColdStartBridge } from './cold-start-bridge';

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
