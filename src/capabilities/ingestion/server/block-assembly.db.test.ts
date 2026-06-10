/**
 * DB-backed tests for the BlockAssembly path-B producer pass (YUK-202, design
 * 2026-06-02 §2 + §3). DB partition: imports tests/helpers/db + the proposal
 * inbox reader (real Postgres testcontainer). A fake `runTaskFn` injects
 * candidates so no real LLM runs.
 *
 * Coverage:
 *  - runBlockAssemblyForSession: fake candidates → `block_merge` proposals land
 *    in the shared inbox (proposalWhere hit), typed change read back.
 *  - <2 blocks → nothing proposed (no merge possible).
 *  - runAutoEnrollForSession wiring: in observe mode the assembly pass proposes
 *    (zero mutation), and a BlockAssemblyTaskError thrown by the AI is SWALLOWED
 *    — the session is NOT flipped and the call does not rethrow (§3).
 */
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import { learning_session, question, question_block } from '@/db/schema';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runAutoEnrollForSession } from './auto-enroll';
import {
  type BlockAssemblyRunTaskFn,
  BlockAssemblyTaskError,
  runBlockAssemblyForSession,
} from './block-assembly';

const OBSERVE_FLAG = 'WORKFLOW_JUDGE_OBSERVE_ENABLED';

function structured(prompt: string, questionNo?: string): StructuredQuestionT {
  return {
    id: createId(),
    role: 'standalone',
    prompt_text: prompt,
    source: 'vlm_structure',
    ...(questionNo ? { question_no: questionNo } : {}),
  };
}

/** Seed an ingestion session + N draft blocks; returns ordered block ids. */
async function seed(
  db: ReturnType<typeof testDb>,
  blockCount = 3,
): Promise<{ sessionId: string; blockIds: string[] }> {
  const now = new Date();
  const sessionId = createId();
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    status: 'extracted',
    source_document_id: createId(),
    source_asset_ids: ['asset_1'],
    entrypoint: 'vision_paper',
    warnings: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const blockIds = Array.from({ length: blockCount }, () => createId());
  await db.insert(question_block).values(
    blockIds.map((id, i) => ({
      id,
      ingestion_session_id: sessionId,
      source_document_id: null,
      source_asset_ids: ['asset_1'],
      page_spans: [],
      structured: structured(`第 ${i + 1} 块题面 ${id}`, String(i + 1)),
      figures: [],
      layout_quality: 'structured' as const,
      image_refs: ['asset_1'],
      crop_refs: [],
      visual_complexity: 'low' as const,
      extraction_confidence: 1,
      status: 'draft' as const,
      knowledge_hint: null,
      merged_from_block_ids: [],
      created_at: now,
      updated_at: now,
      version: 0,
    })),
  );
  return { sessionId, blockIds };
}

describe('runBlockAssemblyForSession', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('maps fake candidates to block_merge proposals that land in the inbox', async () => {
    const db = testDb();
    const { sessionId, blockIds } = await seed(db, 3);
    const [a, b, c] = blockIds;

    // Fake the LLM: two candidates over the seeded blocks.
    const runTaskFn: BlockAssemblyRunTaskFn = async () => ({
      text: JSON.stringify({
        candidates: [
          {
            primary_block_id: a,
            merge_block_ids: [b],
            confidence: 0.88,
            signal: 'numbering',
            reason_md: 'question_no 1 接 2，同一大题被切开',
          },
          {
            primary_block_id: c,
            merge_block_ids: [a],
            confidence: 0.41,
            signal: 'carryover',
            reason_md: '承接前题线索',
          },
        ],
      }),
    });

    const result = await runBlockAssemblyForSession(db, {
      sessionId,
      blocks: [
        { id: a, structured: structured('a', '1'), layout_quality: 'structured' },
        { id: b, structured: structured('b', '2'), layout_quality: 'structured' },
        { id: c, structured: structured('c', '3'), layout_quality: 'structured' },
      ],
      runTaskFn,
    });

    expect(result.proposed).toBe(2);
    expect(result.proposal_ids).toHaveLength(2);

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    const merges = rows.filter((r) => r.kind === 'block_merge');
    expect(merges).toHaveLength(2);
    // Default writer branch (no event_override) → experimental:proposal / question_block.
    expect(merges.every((r) => r.source_action === 'experimental:proposal')).toBe(true);
    expect(merges.every((r) => r.target.subject_kind === 'question_block')).toBe(true);
    expect(merges.every((r) => r.actor_ref === 'block_assembly')).toBe(true);

    const first = merges.find((r) => r.id === result.proposal_ids[0]);
    if (!first || first.payload.kind !== 'block_merge') {
      throw new Error('expected the first block_merge proposal');
    }
    expect(first.payload.proposed_change).toEqual({
      primary_block_id: a,
      merge_block_ids: [b],
      ingestion_session_id: sessionId,
      continuity_signal: 'numbering',
      // YUK-202 fork 4a — confidence IS persisted on proposed_change so the redraw
      // inbox can sort/colour by it (the model's confidence is not recoverable later).
      confidence: 0.88,
    });
  });

  it('drops candidates referencing block ids outside the session (hallucinated)', async () => {
    const db = testDb();
    const { sessionId, blockIds } = await seed(db, 2);
    const [a, b] = blockIds;

    // The model returns one valid candidate (a←b) and one that references a block
    // id not in this session — the latter must be dropped before it reaches the inbox.
    const runTaskFn: BlockAssemblyRunTaskFn = async () => ({
      text: JSON.stringify({
        candidates: [
          {
            primary_block_id: a,
            merge_block_ids: [b],
            confidence: 0.9,
            signal: 'numbering',
            reason_md: '有效候选',
          },
          {
            primary_block_id: a,
            merge_block_ids: ['ghost_block_not_in_session'],
            confidence: 0.7,
            signal: 'carryover',
            reason_md: '幻觉出的不存在块',
          },
        ],
      }),
    });

    const result = await runBlockAssemblyForSession(db, {
      sessionId,
      blocks: [
        { id: a, structured: structured('a', '1'), layout_quality: 'structured' },
        { id: b, structured: structured('b', '2'), layout_quality: 'structured' },
      ],
      runTaskFn,
    });

    // Only the valid candidate is proposed; the hallucinated one is filtered out.
    expect(result.proposed).toBe(1);
    const merges = (await listProposalInboxRows(db, { status: 'pending' })).filter(
      (r) => r.kind === 'block_merge',
    );
    expect(merges).toHaveLength(1);
    if (merges[0].payload.kind !== 'block_merge') throw new Error('expected block_merge');
    expect(merges[0].payload.proposed_change.merge_block_ids).toEqual([b]);
  });

  it('proposes nothing when the session has fewer than two blocks (no merge possible)', async () => {
    const db = testDb();
    const { sessionId, blockIds } = await seed(db, 1);
    let called = false;
    const runTaskFn: BlockAssemblyRunTaskFn = async () => {
      called = true;
      return { text: '{"candidates":[]}' };
    };

    const result = await runBlockAssemblyForSession(db, {
      sessionId,
      blocks: [{ id: blockIds[0], structured: structured('only', '1'), layout_quality: null }],
      runTaskFn,
    });

    expect(result.proposed).toBe(0);
    // The single-block short-circuit means the LLM is never even invoked.
    expect(called).toBe(false);
    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows.filter((r) => r.kind === 'block_merge')).toHaveLength(0);
  });

  it('rethrows BlockAssemblyTaskError to the caller (the auto_enroll wrapper swallows it)', async () => {
    const db = testDb();
    const { sessionId, blockIds } = await seed(db, 2);
    const runTaskFn: BlockAssemblyRunTaskFn = async () => {
      throw new Error('provider down');
    };

    await expect(
      runBlockAssemblyForSession(db, {
        sessionId,
        blocks: blockIds.map((id) => ({
          id,
          structured: structured(id, '1'),
          layout_quality: 'structured',
        })),
        runTaskFn,
      }),
    ).rejects.toBeInstanceOf(BlockAssemblyTaskError);
  });
});

describe('runAutoEnrollForSession — BlockAssembly pass wiring (YUK-202 §3)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('observe mode: the assembly pass proposes block merges with zero block mutation', async () => {
    const db = testDb();
    const { sessionId, blockIds } = await seed(db, 2);
    const [a, b] = blockIds;

    const runBlockAssemblyFn: BlockAssemblyRunTaskFn = async () => ({
      text: JSON.stringify({
        candidates: [
          {
            primary_block_id: a,
            merge_block_ids: [b],
            confidence: 0.9,
            signal: 'stem_answer_split',
            reason_md: 'a 是题干，b 只有答案/解析',
          },
        ],
      }),
    });

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      // observe mode: enroll OFF (default), observe ON (default). Tagging never
      // routes to auto in observe, so we still need a tagging fn (it writes audit
      // events only). We let the real default tagging path be replaced by a stub.
      env: { [OBSERVE_FLAG]: 'true' },
      runTaggingFn: async () => ({
        suggestions: [],
        overall_confidence: 0.1,
        reasoning: 'low',
      }),
      runBlockAssemblyFn,
    });

    // observe mode completes; nothing auto-enrolled.
    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(0);

    // The merge proposal landed in the inbox.
    const rows = await listProposalInboxRows(db, { status: 'pending' });
    const merges = rows.filter((r) => r.kind === 'block_merge');
    expect(merges).toHaveLength(1);

    // Zero block mutation — every block still draft, no question materialized.
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((bl) => bl.status === 'draft')).toBe(true);
    expect(blocks.every((bl) => bl.imported_question_id === null)).toBe(true);
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(0);
  });

  it('swallows a BlockAssembly AI throw: session not flipped, no rethrow', async () => {
    const db = testDb();
    const { sessionId } = await seed(db, 2);

    const runBlockAssemblyFn: BlockAssemblyRunTaskFn = async () => {
      throw new Error('block-assembly provider down');
    };

    // Must NOT throw — the assembly fault is swallowed + logged (§3).
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: { [OBSERVE_FLAG]: 'true' },
      runTaggingFn: async () => ({
        suggestions: [],
        overall_confidence: 0.1,
        reasoning: 'low',
      }),
      runBlockAssemblyFn,
    });

    expect(result.status).toBe('completed');

    // Session status unchanged (still 'extracted') — assembly fault did not flip it.
    const sessionRows = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(sessionRows[0]?.status).toBe('extracted');

    // No block_merge proposal written (the AI threw before any candidate).
    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows.filter((r) => r.kind === 'block_merge')).toHaveLength(0);
  });
});
