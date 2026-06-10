/**
 * Tests for runAutoEnrollForSession — T-OC slice 3 (YUK-145, OC-4 / OC-5).
 *
 * DB-backed. Injected TaggingTask fn so no real LLM runs. The headline test is
 * the CRITICAL SAFETY one: with the flag OFF (default), NOTHING auto-enrolls and
 * every block stays 'draft' for the existing human review flow. See ADR-0026 +
 * docs/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md §4.
 */
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MistakeEnrollOutputT } from '@/core/schema/mistake_enroll';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { TaggingOutputT } from '@/core/schema/tagging';
import type { Db } from '@/db/client';
import {
  event,
  knowledge,
  learning_record,
  learning_session,
  question,
  question_block,
} from '@/db/schema';
import type { WriteEventInput } from '@/server/events/queries';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { observeEventId, runAutoEnrollForSession } from './auto-enroll';
import { MistakeEnrollTaskError, type RunMistakeEnrollTaskParams } from './mistake_enroll';
import { TaggingTaskError } from './tagging';

const FLAG = 'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED';
const OBSERVE_FLAG = 'WORKFLOW_JUDGE_OBSERVE_ENABLED';
const OBSERVE_ACTION = 'experimental:auto_enroll_observed';

function structured(prompt: string): StructuredQuestionT {
  return { id: createId(), role: 'standalone', prompt_text: prompt, source: 'vlm_structure' };
}

async function seed(
  db: ReturnType<typeof testDb>,
): Promise<{ sessionId: string; blockIds: string[] }> {
  const now = new Date();
  await db.insert(knowledge).values({
    id: 'k1',
    name: '虚词',
    domain: 'wenyan',
    parent_id: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
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
  const blockIds = [createId(), createId()];
  await db.insert(question_block).values(
    blockIds.map((id) => ({
      id,
      ingestion_session_id: sessionId,
      source_document_id: null,
      source_asset_ids: ['asset_1'],
      page_spans: [],
      structured: structured(`下列句中「之」的用法 ${id}`),
      figures: [],
      layout_quality: 'structured',
      image_refs: ['asset_1'],
      crop_refs: [],
      visual_complexity: 'low',
      extraction_confidence: 1,
      status: 'draft',
      knowledge_hint: '之',
      merged_from_block_ids: [],
      created_at: now,
      updated_at: now,
      version: 0,
    })),
  );
  return { sessionId, blockIds };
}

/**
 * Seed an ingestion session in a chosen status (default 'extracted') + N draft
 * blocks. Each block embeds its own id in the prompt so a runTaggingFn can branch
 * per-block on `questionMd` (used by the per-block isolation cases).
 */
async function seedWithStatus(
  db: ReturnType<typeof testDb>,
  status: 'extracted' | 'partial',
  blockCount = 2,
): Promise<{ sessionId: string; blockIds: string[] }> {
  const now = new Date();
  await db.insert(knowledge).values({
    id: 'k1',
    name: '虚词',
    domain: 'wenyan',
    parent_id: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const sessionId = createId();
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    status,
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
    blockIds.map((id) => ({
      id,
      ingestion_session_id: sessionId,
      source_document_id: null,
      source_asset_ids: ['asset_1'],
      page_spans: [],
      structured: structured(`下列句中「之」的用法 ${id}`),
      figures: [],
      layout_quality: 'structured' as const,
      image_refs: ['asset_1'],
      crop_refs: [],
      visual_complexity: 'low' as const,
      extraction_confidence: 1,
      status: 'draft' as const,
      knowledge_hint: '之',
      merged_from_block_ids: [],
      created_at: now,
      updated_at: now,
      version: 0,
    })),
  );
  return { sessionId, blockIds };
}

const highConfidenceTagging = async (): Promise<TaggingOutputT> => ({
  suggestions: [{ knowledge_id: 'k1', confidence: 0.95, reasoning: 'ok' }],
  overall_confidence: 0.95,
  reasoning: 'high',
});

const lowConfidenceTagging = async (): Promise<TaggingOutputT> => ({
  suggestions: [{ knowledge_id: 'k1', confidence: 0.3, reasoning: 'meh' }],
  overall_confidence: 0.3,
  reasoning: 'low',
});

describe('runAutoEnrollForSession', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ===========================================================================
  // CRITICAL SAFETY: enroll OFF + observe OFF → hard no-op. Slice B (YUK-190)
  // INVERTED the default OFF behavior to observe-only (see the observe cases
  // below); the legacy hard no-op now requires WORKFLOW_JUDGE_OBSERVE_ENABLED
  // explicitly 'false'. The flag-ON enroll path below is unchanged.
  // ===========================================================================
  it('enroll OFF + observe OFF: hard no-op, nothing enrolled, all blocks stay draft', async () => {
    const db = testDb();
    const { sessionId, blockIds } = await seed(db);

    let taggingCalled = false;
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: { [OBSERVE_FLAG]: 'false' }, // enroll undefined → OFF; observe explicitly OFF
      runTaggingFn: async () => {
        taggingCalled = true;
        return highConfidenceTagging();
      },
    });

    expect(result.status).toBe('skipped:flag_off');
    expect(result.enrolled).toBe(0);
    // The judge / tagging never even runs when both flags are off.
    expect(taggingCalled).toBe(false);

    // Every block is untouched: still 'draft', no question, no event.
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
    expect(blocks.every((b) => b.imported_question_id === null)).toBe(true);

    const questions = await db.select().from(question);
    expect(questions).toHaveLength(0);
    const events = await db.select().from(event);
    expect(events).toHaveLength(0);
    expect(blockIds).toHaveLength(2);
  });

  it("enroll explicitly 'false' + observe OFF → still hard no-op", async () => {
    const db = testDb();
    const { sessionId } = await seed(db);
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: { [FLAG]: 'false', [OBSERVE_FLAG]: 'false' },
      runTaggingFn: highConfidenceTagging,
    });
    expect(result.status).toBe('skipped:flag_off');
    expect(result.enrolled).toBe(0);
  });

  // ===========================================================================
  // Flag ON: high confidence → auto-enroll with generated_by='workflow_judge'.
  // ===========================================================================
  it('flag ON + high confidence: auto-enrolls with workflow_judge provenance', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      runTaggingFn: highConfidenceTagging,
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(2);
    expect(result.routed_to_review).toBe(0);

    // Both blocks flipped to 'auto_enrolled' (NOT human 'imported') + linked to a question.
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'auto_enrolled')).toBe(true);
    expect(blocks.every((b) => b.imported_question_id !== null)).toBe(true);

    // Questions created with the prefilled knowledge ids.
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(2);
    expect(questions.every((q) => q.knowledge_ids.includes('k1'))).toBe(true);

    // outcome=unanswered → no attempt event, but a record_capture event with the
    // workflow_judge provenance marker (OC-5).
    const attempts = await db.select().from(event).where(eq(event.action, 'attempt'));
    expect(attempts).toHaveLength(0);
    const captures = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:record_capture'));
    expect(captures).toHaveLength(2);
    expect(
      captures.every(
        (e) => (e.payload as Record<string, unknown>).generated_by === 'workflow_judge',
      ),
    ).toBe(true);

    // open_question records created (unanswered = item/material).
    const records = await db.select().from(learning_record);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.kind === 'open_question')).toBe(true);
  });

  // ===========================================================================
  // Flag ON: low confidence → routed to review, block stays draft (no change).
  // ===========================================================================
  it('flag ON + low confidence: routes to review, block stays draft', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      runTaggingFn: lowConfidenceTagging,
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(0);
    expect(result.routed_to_review).toBe(2);

    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(0);
  });

  it('flag ON + tagging outage: routes to review (never auto-enrolls on failure)', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      runTaggingFn: async () => {
        throw new TaggingTaskError('provider down');
      },
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(0);
    expect(result.routed_to_review).toBe(2);
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
  });

  it('skips when session is not in an extractable status', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);
    await db
      .update(learning_session)
      .set({ status: 'imported' })
      .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'ingestion')));

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: { [FLAG]: 'true' },
      runTaggingFn: highConfidenceTagging,
    });
    expect(result.status).toBe('skipped:wrong_status');
    expect(result.enrolled).toBe(0);
  });

  it('skips when the session does not exist', async () => {
    const db = testDb();
    const result = await runAutoEnrollForSession({
      db,
      sessionId: createId(),
      env: { [FLAG]: 'true' },
      runTaggingFn: highConfidenceTagging,
    });
    expect(result.status).toBe('skipped:session_not_found');
  });

  // ===========================================================================
  // Strategy D Slice B (YUK-190): OBSERVE-ONLY semantics.
  // ===========================================================================

  // (a) Headline: flag OFF + observe ON (default) ⇒ observe-only. Uses
  // highConfidenceTagging so the ONLY thing preventing enrollment is the mode
  // branch — proves observe writes the audit trail but changes zero domain state.
  it('(a) flag OFF + observe ON: observe-only, zero domain rows, blocks stay draft', async () => {
    const db = testDb();
    const { sessionId, blockIds } = await seed(db);

    let taggingCalled = 0;
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: {}, // enroll undefined → OFF; observe undefined → ON
      runTaggingFn: async () => {
        taggingCalled += 1;
        return highConfidenceTagging();
      },
    });

    // Observe runs tagging+judge but enrolls nothing.
    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(0);
    expect(result.routed_to_review).toBe(0);
    expect(taggingCalled).toBe(2);

    // N observe events, each fully shaped.
    const observed = await db.select().from(event).where(eq(event.action, OBSERVE_ACTION));
    expect(observed).toHaveLength(2);
    for (const e of observed) {
      const p = e.payload as Record<string, unknown>;
      expect(p.mode).toBe('observe');
      expect(p.generated_by).toBe('workflow_judge');
      expect(p.route).toBe('auto');
      expect(typeof p.confidence).toBe('number');
      expect(Array.isArray(p.suggested_knowledge_ids)).toBe(true);
      expect((p.suggested_knowledge_ids as string[]).includes('k1')).toBe(true);
      expect(e.outcome).toBe('success');
      expect(e.subject_kind).toBe('question_block');
      // ★ Memory-outbox opt-out (§3.5): every observe event is ingest-stamped.
      expect(e.ingest_at).not.toBeNull();
    }
    // Deterministic ids tie each event to its block.
    const observedIds = new Set(observed.map((e) => e.id));
    for (const blockId of blockIds) {
      expect(observedIds.has(observeEventId(sessionId, blockId))).toBe(true);
    }

    // No record_capture events (distinct count — not just events.length).
    const captures = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:record_capture'));
    expect(captures).toHaveLength(0);

    // Zero domain rows.
    expect(await db.select().from(learning_record)).toHaveLength(0);
    expect(await db.select().from(question)).toHaveLength(0);

    // Every block untouched: draft + both imported_* columns null.
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
    expect(blocks.every((b) => b.imported_question_id === null)).toBe(true);
    expect(blocks.every((b) => b.imported_attempt_event_id === null)).toBe(true);

    // Session unchanged (no commitImport).
    const sessionRows = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(sessionRows[0]?.status).toBe('extracted');
    expect(sessionRows[0]?.ended_at).toBeNull();
  });

  // (a) contrast: low confidence ⇒ route 'review', still an observe event with
  // outcome 'skipped', still draft, still ingest-stamped.
  it('(a) observe low-confidence: route review, outcome skipped, still draft + stamped', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: {},
      runTaggingFn: lowConfidenceTagging,
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(0);
    const observed = await db.select().from(event).where(eq(event.action, OBSERVE_ACTION));
    expect(observed).toHaveLength(2);
    for (const e of observed) {
      expect((e.payload as Record<string, unknown>).route).toBe('review');
      expect(e.outcome).toBe('skipped');
      expect(e.ingest_at).not.toBeNull();
    }
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
  });

  // (a-partial) observe on a 'partial' session: status gate accepts partial;
  // session stays partial, blocks stay draft, zero domain rows.
  it('(a-partial) observe on a partial session: stays partial, blocks draft, observes', async () => {
    const db = testDb();
    const { sessionId } = await seedWithStatus(db, 'partial');

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: {},
      runTaggingFn: highConfidenceTagging,
    });

    expect(result.status).toBe('completed');
    const observed = await db.select().from(event).where(eq(event.action, OBSERVE_ACTION));
    expect(observed).toHaveLength(2);
    expect(await db.select().from(question)).toHaveLength(0);
    expect(await db.select().from(learning_record)).toHaveLength(0);
    const sessionRows = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(sessionRows[0]?.status).toBe('partial');
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
  });

  // (b) Missing-key shape (TaggingTaskError) ⇒ route-to-review, NO throw, 0
  // observe events (no block was judged), all draft, session unchanged.
  it('(b) observe + tagging error (missing-key shape): route to review, no observe event', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: {},
      runTaggingFn: async () => {
        throw new TaggingTaskError('TaggingTask LLM call failed');
      },
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(0);
    expect(result.routed_to_review).toBe(2);
    expect(await db.select().from(event).where(eq(event.action, OBSERVE_ACTION))).toHaveLength(0);
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
    const sessionRows = await db
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(sessionRows[0]?.status).toBe('extracted');
  });

  // (b2) A plain Error (the only thing the runner re-throws) escapes the runner;
  // buildAutoEnrollHandler re-throws it (infra classification → pg-boss retry).
  it('(b2) observe + plain Error escapes runner; handler re-throws (no swallow)', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    // Runner surfaces the plain Error (the only thing the per-block catch
    // re-raises — a non-TaggingTaskError).
    await expect(
      runAutoEnrollForSession({
        db,
        sessionId,
        env: {},
        runTaggingFn: async () => {
          throw new Error('db connection lost');
        },
      }),
    ).rejects.toThrow('db connection lost');

    // buildAutoEnrollHandler re-throws an escaping fault so pg-boss retries on the
    // auto_enroll queue alone (mirrors attribution_followup). Spy the runner the
    // handler imports so the escaping infra fault is deterministic.
    const autoEnrollModule = await import('./auto-enroll');
    const spy = vi
      .spyOn(autoEnrollModule, 'runAutoEnrollForSession')
      .mockRejectedValueOnce(new Error('db connection lost'));
    const { buildAutoEnrollHandler } = await import('@/server/boss/handlers/auto_enroll');
    const handler = buildAutoEnrollHandler(db);
    await expect(handler([{ id: 'job-1', data: { sessionId } } as never])).rejects.toThrow(
      'db connection lost',
    );
    spy.mockRestore();
  });

  // (c) Idempotent on re-run: deterministic id + onConflictDoNothing ⇒ exactly N
  // observe events after two runs; tagging IS re-called (2N) — idempotency is NOT
  // achieved by short-circuiting tagging.
  it('(c) observe idempotent on re-run: N events, draft, 2N tagging calls', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    let taggingCalled = 0;
    const fn = async () => {
      taggingCalled += 1;
      return highConfidenceTagging();
    };
    await runAutoEnrollForSession({ db, sessionId, env: {}, runTaggingFn: fn });
    await runAutoEnrollForSession({ db, sessionId, env: {}, runTaggingFn: fn });

    expect(await db.select().from(event).where(eq(event.action, OBSERVE_ACTION))).toHaveLength(2);
    expect(taggingCalled).toBe(4);
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
  });

  // (d) Per-block isolation: tagging throws for block 1 (branch on the id baked
  // into questionMd) and succeeds for block 2. Block 1 → no event, draft; block 2
  // → observe event, draft; no throw.
  it('(d) observe per-block isolation: one tagging failure does not abort the batch', async () => {
    const db = testDb();
    const { sessionId, blockIds } = await seed(db);
    const [block1, block2] = blockIds;

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: {},
      runTaggingFn: async ({ questionMd }) => {
        if (questionMd.includes(block1)) throw new TaggingTaskError('block 1 down');
        return highConfidenceTagging();
      },
    });

    expect(result.status).toBe('completed');
    const observed = await db.select().from(event).where(eq(event.action, OBSERVE_ACTION));
    expect(observed).toHaveLength(1);
    expect(observed[0]?.subject_id).toBe(block2);
    expect(observed[0]?.id).toBe(observeEventId(sessionId, block2));
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
  });

  // (e) Observe-write failure isolation (§5.4): writeEventFn throws for block 1
  // only. Block 2 still gets its observe event; the job does not throw.
  it('(e) observe-write failure isolation: a failed audit write does not abort', async () => {
    const db = testDb();
    const { sessionId, blockIds } = await seed(db);
    const [block1, block2] = blockIds;

    let realWritten = 0;
    const writeEventFn = async (innerDb: Db, input: WriteEventInput): Promise<string> => {
      if (input.subject_id === block1) throw new Error('audit write failed');
      const { writeEvent } = await import('@/server/events/queries');
      realWritten += 1;
      return writeEvent(innerDb, input);
    };

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: {},
      runTaggingFn: highConfidenceTagging,
      writeEventFn,
    });

    expect(result.status).toBe('completed');
    expect(realWritten).toBe(1);
    const observed = await db.select().from(event).where(eq(event.action, OBSERVE_ACTION));
    expect(observed).toHaveLength(1);
    expect(observed[0]?.subject_id).toBe(block2);
  });

  // (f) Paired flag-is-sole-switch: same seed + same highConfidenceTagging differ
  // ONLY in Phase B. observe → 0 questions / 0 records / N observe events / draft;
  // enroll → N questions / N records / N record_capture / imported.
  it('(f) flag is the sole differentiator between observe and enroll', async () => {
    // observe run
    const dbObserve = testDb();
    const observeSeed = await seed(dbObserve);
    await runAutoEnrollForSession({
      db: dbObserve,
      sessionId: observeSeed.sessionId,
      subjectId: 'wenyan',
      env: {},
      runTaggingFn: highConfidenceTagging,
    });
    expect(await dbObserve.select().from(question)).toHaveLength(0);
    expect(await dbObserve.select().from(learning_record)).toHaveLength(0);
    expect(
      await dbObserve.select().from(event).where(eq(event.action, OBSERVE_ACTION)),
    ).toHaveLength(2);
    const observeBlocks = await dbObserve
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, observeSeed.sessionId));
    expect(observeBlocks.every((b) => b.status === 'draft')).toBe(true);

    // enroll run (fresh DB)
    await resetDb();
    const dbEnroll = testDb();
    const enrollSeed = await seed(dbEnroll);
    await runAutoEnrollForSession({
      db: dbEnroll,
      sessionId: enrollSeed.sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      runTaggingFn: highConfidenceTagging,
    });
    expect(await dbEnroll.select().from(question)).toHaveLength(2);
    expect(await dbEnroll.select().from(learning_record)).toHaveLength(2);
    expect(
      await dbEnroll.select().from(event).where(eq(event.action, 'experimental:record_capture')),
    ).toHaveLength(2);
    expect(
      await dbEnroll.select().from(event).where(eq(event.action, OBSERVE_ACTION)),
    ).toHaveLength(0);
    const enrollBlocks = await dbEnroll
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, enrollSeed.sessionId));
    expect(enrollBlocks.every((b) => b.status === 'auto_enrolled')).toBe(true);
  });

  // (g) Regression: enroll mode rejects a 'partial' session (§8 guard) so a
  // careless flag flip can never enroll on a session the manual guard rejects.
  it('(g) enroll mode rejects a partial session (observe accepts it)', async () => {
    const db = testDb();
    const { sessionId } = await seedWithStatus(db, 'partial');

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      runTaggingFn: highConfidenceTagging,
    });

    expect(result.status).toBe('skipped:wrong_status');
    expect(result.enrolled).toBe(0);
    expect(await db.select().from(question)).toHaveLength(0);
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
  });

  // (h) Off knob: observe explicitly disabled (and enroll OFF) ⇒ hard no-op
  // (pre-Slice-B behavior): no observe events, no tagging calls.
  it('(h) observe OFF knob: true no-op, no observe events, no tagging', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);

    let taggingCalled = false;
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: { [OBSERVE_FLAG]: 'false' },
      runTaggingFn: async () => {
        taggingCalled = true;
        return highConfidenceTagging();
      },
    });

    expect(result.status).toBe('skipped:flag_off');
    expect(taggingCalled).toBe(false);
    expect(await db.select().from(event).where(eq(event.action, OBSERVE_ACTION))).toHaveLength(0);
  });
});

// ===========================================================================
// T-OC slice A1 (YUK-145): MistakeEnrollTask observe-only draft. For an
// ANSWERED block (wrong_answer_md non-empty) routed 'auto', the observe branch
// drafts mistake metadata and attaches it to the audit event under
// payload.mistake_draft. Still zero domain rows; enroll path untouched.
// ===========================================================================

const DRAFT: MistakeEnrollOutputT = {
  wrong_answer: 'failure',
  question_type: 'computation',
  difficulty: 3,
  cause: {
    primary_category: 'other',
    secondary_categories: [],
    analysis_md: 'drafted',
    confidence: 0.7,
  },
  overall_confidence: 0.66,
  reasoning: 'drafted by stub',
};

/** Seed like `seed()` but with a captured student answer on each block. */
async function seedAnswered(
  db: ReturnType<typeof testDb>,
  blockCount = 1,
): Promise<{ sessionId: string; blockIds: string[] }> {
  const now = new Date();
  await db.insert(knowledge).values({
    id: 'k1',
    name: '虚词',
    domain: 'wenyan',
    parent_id: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
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
    blockIds.map((id) => ({
      id,
      ingestion_session_id: sessionId,
      source_document_id: null,
      source_asset_ids: ['asset_1'],
      page_spans: [],
      structured: structured(`下列句中「之」的用法 ${id}`),
      reference_md: '参考答案',
      wrong_answer_md: '学生错答',
      figures: [],
      layout_quality: 'structured' as const,
      image_refs: ['asset_1'],
      crop_refs: [],
      visual_complexity: 'low' as const,
      extraction_confidence: 1,
      status: 'draft' as const,
      knowledge_hint: '之',
      merged_from_block_ids: [],
      created_at: now,
      updated_at: now,
      version: 0,
    })),
  );
  return { sessionId, blockIds };
}

describe('runAutoEnrollForSession — MistakeEnroll draft (A1)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // HEADLINE SAFETY: flag off → the draft producer is never invoked, no events.
  it('mode off: never invokes the draft producer, writes nothing', async () => {
    const db = testDb();
    const { sessionId } = await seedAnswered(db);
    const runMistakeEnrollFn = vi.fn(async () => DRAFT);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: { [OBSERVE_FLAG]: 'false' },
      runTaggingFn: highConfidenceTagging,
      runMistakeEnrollFn,
    });

    expect(result.status).toBe('skipped:flag_off');
    expect(runMistakeEnrollFn).not.toHaveBeenCalled();
    expect(await db.select().from(event)).toHaveLength(0);
  });

  // observe + answered + auto → exactly one observe event carrying mistake_draft;
  // zero domain rows; block stays draft.
  it('observe + answered + auto: attaches mistake_draft to the audit event', async () => {
    const db = testDb();
    const { sessionId, blockIds } = await seedAnswered(db);
    const runMistakeEnrollFn = vi.fn(async (_p: RunMistakeEnrollTaskParams) => DRAFT);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: {},
      runTaggingFn: highConfidenceTagging,
      runMistakeEnrollFn,
    });

    expect(result.status).toBe('completed');
    expect(runMistakeEnrollFn).toHaveBeenCalledTimes(1);
    // The producer saw the captured answer.
    expect(runMistakeEnrollFn.mock.calls[0][0]).toMatchObject({ studentAnswerMd: '学生错答' });

    const observed = await db.select().from(event).where(eq(event.action, OBSERVE_ACTION));
    expect(observed).toHaveLength(1);
    expect(observed[0]?.id).toBe(observeEventId(sessionId, blockIds[0]));
    const p = observed[0]?.payload as Record<string, unknown>;
    expect(p.mistake_draft).toMatchObject({
      wrong_answer: 'failure',
      question_type: 'computation',
    });

    // Still zero domain rows; block untouched.
    expect(await db.select().from(question)).toHaveLength(0);
    expect(await db.select().from(learning_record)).toHaveLength(0);
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'draft')).toBe(true);
  });

  // observe + answered + review route → producer NOT invoked; event has no draft.
  it('observe + answered but routed review: no draft, observe event still written', async () => {
    const db = testDb();
    const { sessionId } = await seedAnswered(db);
    const runMistakeEnrollFn = vi.fn(async () => DRAFT);

    await runAutoEnrollForSession({
      db,
      sessionId,
      env: {},
      runTaggingFn: lowConfidenceTagging, // → route 'review'
      runMistakeEnrollFn,
    });

    expect(runMistakeEnrollFn).not.toHaveBeenCalled();
    const observed = await db.select().from(event).where(eq(event.action, OBSERVE_ACTION));
    expect(observed).toHaveLength(1);
    expect((observed[0]?.payload as Record<string, unknown>).mistake_draft).toBeUndefined();
  });

  // observe + UNANSWERED (no wrong_answer_md) → producer NOT invoked (regression
  // guard for the existing unanswered observe path).
  it('observe + unanswered: producer not invoked, no mistake_draft key', async () => {
    const db = testDb();
    const { sessionId } = await seed(db); // seed() has no wrong_answer_md
    const runMistakeEnrollFn = vi.fn(async () => DRAFT);

    await runAutoEnrollForSession({
      db,
      sessionId,
      env: {},
      runTaggingFn: highConfidenceTagging,
      runMistakeEnrollFn,
    });

    expect(runMistakeEnrollFn).not.toHaveBeenCalled();
    const observed = await db.select().from(event).where(eq(event.action, OBSERVE_ACTION));
    expect(observed).toHaveLength(2);
    expect(
      observed.every((e) => (e.payload as Record<string, unknown>).mistake_draft === undefined),
    ).toBe(true);
  });

  // Draft outage isolation: the producer throws → observe event still written
  // WITHOUT mistake_draft; batch continues; no throw.
  it('draft outage: a MistakeEnrollTaskError leaves the event draft-less, no throw', async () => {
    const db = testDb();
    const { sessionId } = await seedAnswered(db);
    const runMistakeEnrollFn = vi.fn(async () => {
      throw new MistakeEnrollTaskError('draft provider down');
    });

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      env: {},
      runTaggingFn: highConfidenceTagging,
      runMistakeEnrollFn,
    });

    expect(result.status).toBe('completed');
    const observed = await db.select().from(event).where(eq(event.action, OBSERVE_ACTION));
    expect(observed).toHaveLength(1);
    expect((observed[0]?.payload as Record<string, unknown>).mistake_draft).toBeUndefined();
  });

  // Infra-fault isolation: a NON-MistakeEnrollTaskError (e.g. DB connection lost)
  // is NOT swallowed — it escapes so buildAutoEnrollHandler re-throws → pg-boss
  // retries (mirrors the TaggingTask (b2) contract). Guards the silent-failure
  // regression where the catch is widened to swallow everything.
  it('draft infra fault (plain Error) escapes the runner; not swallowed', async () => {
    const db = testDb();
    const { sessionId } = await seedAnswered(db);
    const runMistakeEnrollFn = vi.fn(async () => {
      throw new Error('db connection lost');
    });

    await expect(
      runAutoEnrollForSession({
        db,
        sessionId,
        env: {},
        runTaggingFn: highConfidenceTagging,
        runMistakeEnrollFn,
      }),
    ).rejects.toThrow('db connection lost');
  });
});

// ===========================================================================
// T-OC slice A2 (YUK-164): ENROLL mode (flag ON) enrolls the REAL outcome from
// the MistakeEnrollTask draft for an ANSWERED block, sets status 'auto_enrolled'
// (NOT human 'imported'), and writes the drafted cause as a chained judge event.
// ===========================================================================
describe('runAutoEnrollForSession — A2 answered enroll (flag ON)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('enrolls a failure attempt + mistake + drafted-cause judge event; block auto_enrolled', async () => {
    const db = testDb();
    const { sessionId, blockIds } = await seedAnswered(db);
    const runMistakeEnrollFn = vi.fn(async () => DRAFT); // wrong_answer:'failure' + cause

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      runTaggingFn: highConfidenceTagging,
      runMistakeEnrollFn,
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(1);

    // Real failure attempt on the question (NOT unanswered/open_question).
    const attempts = await db.select().from(event).where(eq(event.action, 'attempt'));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('failure');
    expect((attempts[0]?.payload as Record<string, unknown>).answer_md).toBe('学生错答');

    // Mistake record (failure → 'mistake', not 'open_question').
    const records = await db.select().from(learning_record);
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe('mistake');

    // Drafted cause written as a chained judge event on the attempt.
    const judges = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.subject_kind, 'event')));
    expect(judges).toHaveLength(1);
    expect(judges[0]?.caused_by_event_id).toBe(attempts[0]?.id);
    const cause = (judges[0]?.payload as { cause?: { primary_category?: string } }).cause;
    expect(cause?.primary_category).toBe('other');

    // Block is auto_enrolled (revertible), NOT human imported.
    const blocks = await db.select().from(question_block).where(eq(question_block.id, blockIds[0]));
    expect(blocks[0]?.status).toBe('auto_enrolled');
    expect(blocks[0]?.imported_question_id).not.toBeNull();
  });

  it('a success draft enrolls a worked_example with NO cause judge event', async () => {
    const db = testDb();
    const { sessionId } = await seedAnswered(db);
    const runMistakeEnrollFn = vi.fn(async () => ({
      ...DRAFT,
      wrong_answer: 'success' as const,
      cause: null,
    }));

    await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      runTaggingFn: highConfidenceTagging,
      runMistakeEnrollFn,
    });

    const attempts = await db.select().from(event).where(eq(event.action, 'attempt'));
    expect(attempts[0]?.outcome).toBe('success');
    const records = await db.select().from(learning_record);
    expect(records[0]?.kind).toBe('worked_example');
    expect(await db.select().from(event).where(eq(event.action, 'judge'))).toHaveLength(0);
  });

  it('a draft outage falls back to unanswered (open_question); block still auto_enrolled, no throw', async () => {
    const db = testDb();
    const { sessionId } = await seedAnswered(db);
    const runMistakeEnrollFn = vi.fn(async () => {
      throw new MistakeEnrollTaskError('draft down');
    });

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      runTaggingFn: highConfidenceTagging,
      runMistakeEnrollFn,
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(1);
    // No attempt event (unanswered fallback); open_question record.
    expect(await db.select().from(event).where(eq(event.action, 'attempt'))).toHaveLength(0);
    const records = await db.select().from(learning_record);
    expect(records[0]?.kind).toBe('open_question');
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks.every((b) => b.status === 'auto_enrolled')).toBe(true);
  });
});
