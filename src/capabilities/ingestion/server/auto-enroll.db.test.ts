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
  mastery_state,
  question,
  question_block,
} from '@/db/schema';
import type { WriteEventInput } from '@/server/events/queries';
import { getProposalInboxRow, listProposalInboxRows } from '@/server/proposals/inbox';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  type GradeStudentAnswerFn,
  type RunAutoEnrollParams,
  detectStudentWork,
  extractionAssessedHandwriting,
  observeEventId,
  runAutoEnrollForSession,
  shouldGradeStudentWork,
} from './auto-enroll';
import { MistakeEnrollTaskError, type RunMistakeEnrollTaskParams } from './mistake_enroll';
import { TaggingTaskError } from './tagging';

const FLAG = 'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED';
const OBSERVE_FLAG = 'WORKFLOW_JUDGE_OBSERVE_ENABLED';
const OBSERVE_ACTION = 'experimental:auto_enroll_observed';
// YUK-482 cut ④ — student-answer grading flag (independent of auto-enroll FLAG).
const GRADE_FLAG = 'WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED';

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

// P3 (YUK-489): the ENROLL path runs the unified `tagKnowledge`, not the grid-prefill
// TaggingTask. DB tests inject a `tagKnowledgeFn` stub (mirroring tag-knowledge.db.test.ts's
// embedFn/nameKcFn stubs) so no embedding/naming model is called.
//
// matchK1 — always MATCHES the seeded `k1` KC (the common enroll case): the question attributes
// to k1 with no new KC minted.
const matchK1: RunAutoEnrollParams['tagKnowledgeFn'] = async () => ({
  kind: 'match',
  knowledge_ids: ['k1'],
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
      tagKnowledgeFn: matchK1,
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
  // Flag ON: low EXTRACTION confidence → routed to review, block stays draft.
  // P3 (YUK-489): tagging is no longer a routing-uncertainty source on the enroll path
  // (tagKnowledge always attributes ≥1 KC at full confidence), so the only thing that can
  // route an enroll block to review is the weakest-link extraction confidence falling below the
  // threshold. Seed a block with low extraction_confidence to exercise that gate.
  // ===========================================================================
  it('flag ON + low EXTRACTION confidence: routes to review, block stays draft', async () => {
    const db = testDb();
    const { sessionId } = await seed(db);
    // Drop both blocks' extraction confidence below the default 0.85 threshold.
    await db
      .update(question_block)
      .set({ extraction_confidence: 0.3 })
      .where(eq(question_block.ingestion_session_id, sessionId));

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      tagKnowledgeFn: matchK1,
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
      // A tagKnowledge throw (provider down / missing seed root) must NEVER auto-enroll.
      tagKnowledgeFn: async () => {
        throw new Error('tagKnowledge provider down');
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
  // P3 (YUK-489) — unified tagKnowledge on the ENROLL path. The old cold-start-bridge
  // signature gate is GONE; tagKnowledge subsumes it. On a thin-seed tree (only a subject-root
  // KC) a block whose content matches no in-subject KC PROPOSEs a fresh child (tagKnowledge mints
  // it live + approved in its OWN tx + an `experimental:auto_tag_kc_created` audit event), and the
  // enroll path materializes a placement-answerable question attributed to it. A tagKnowledge
  // outage (provider down / missing seed root) routes-to-review. tagKnowledge is stubbed (no real
  // embedding/naming model) — these tests assert the auto-enroll WIRING around it, not its
  // internals (those live in tag-knowledge.db.test.ts).
  // ===========================================================================

  // A tagKnowledgeFn stub that PROPOSEs a fresh KC: it mimics the real tagKnowledge propose path
  // by minting an approved child under the subject root + the audit event, then returning
  // kind:'propose'. (The auto-enroll path only consumes `knowledge_ids`; we create the row so the
  // structural-verify gate sees a live KC and the question lands 'active'.)
  const proposeChildKc =
    (kcName: string): NonNullable<RunAutoEnrollParams['tagKnowledgeFn']> =>
    async (deps, input) => {
      const childId = createId();
      const now = new Date();
      await deps.db.insert(knowledge).values({
        id: childId,
        name: kcName,
        domain: null,
        parent_id: input.subjectRootId,
        archived_at: null,
        proposed_by_ai: true,
        approval_status: 'approved',
        created_at: now,
        updated_at: now,
        version: 0,
      } as typeof knowledge.$inferInsert);
      await deps.db.insert(event).values({
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'tag_knowledge',
        action: 'experimental:auto_tag_kc_created',
        subject_kind: 'knowledge',
        subject_id: childId,
        outcome: 'success',
        payload: {
          source: 'tag_knowledge',
          auto_created_kc_id: childId,
          subject_root_id: input.subjectRootId,
          name: kcName,
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });
      return { kind: 'propose', knowledge_ids: [childId], kc_name: kcName };
    };

  // Seed a THIN tree: only the wenyan subject-root seed node (id seed:wenyan:root,
  // domain 'wenyan'), plus one ingestion session + one draft block. No concept KCs — the
  // tagKnowledge stub PROPOSEs a child under the root.
  async function seedThinTree(
    db: ReturnType<typeof testDb>,
  ): Promise<{ sessionId: string; blockId: string }> {
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'seed:wenyan:root',
      name: '文言文',
      domain: 'wenyan',
      parent_id: null,
      archived_at: null,
      proposed_by_ai: false,
      approval_status: 'approved',
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
    const blockId = createId();
    await db.insert(question_block).values({
      id: blockId,
      ingestion_session_id: sessionId,
      source_document_id: null,
      source_asset_ids: ['asset_1'],
      page_spans: [],
      structured: structured('翻译：学而时习之，不亦说乎'),
      figures: [],
      layout_quality: 'structured',
      image_refs: [],
      crop_refs: [],
      visual_complexity: 'low',
      extraction_confidence: 1,
      status: 'draft',
      // OCR got the prompt but NOT the reference answer. P3: we do NOT synthesize one (P4a).
      reference_md: null,
      knowledge_hint: '论语',
      merged_from_block_ids: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    return { sessionId, blockId };
  }

  it('tagKnowledge PROPOSE with NO subjectId (prod job shape) → bridge classifies subject → child under seed:<classified>:root', async () => {
    const db = testDb();
    const { sessionId } = await seedThinTree(db);

    // The production job (jobs/auto_enroll.ts) calls runAutoEnrollForSession WITHOUT a subjectId.
    // The enroll path must CLASSIFY the subject via the cold-start bridge, resolve
    // seed:<subject>:root, and tag under it — NOT build `seed:undefined:root` (which would throw
    // in applyProposeNew and route every thin-tree block to review the moment enroll is flipped).
    let tagRootSeen: string | null = null;
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      // subjectId omitted on purpose (prod job shape).
      env: { [FLAG]: 'true' },
      // Bridge classifies the subject (+ names the KC); only its subject_id is load-bearing here.
      runColdStartBridgeFn: async () => ({
        text: JSON.stringify({
          reasoning: '',
          subject_id: 'wenyan',
          kc_name: '《论语》句子翻译',
          reference_md: '',
        }),
      }),
      tagKnowledgeFn: async (deps, input) => {
        tagRootSeen = input.subjectRootId;
        return proposeChildKc('《论语》句子翻译')(deps, input);
      },
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(1);
    expect(result.routed_to_review).toBe(0);
    // The bridge-classified root was used — NOT seed:undefined:root.
    expect(tagRootSeen).toBe('seed:wenyan:root');
    const children = await db
      .select()
      .from(knowledge)
      .where(eq(knowledge.parent_id, 'seed:wenyan:root'));
    expect(children).toHaveLength(1);
    expect(children[0].name).toBe('《论语》句子翻译');
  });

  it('tagKnowledge PROPOSE: thin tree + no KC match → mints child KC + audit trail + placement-answerable question', async () => {
    const db = testDb();
    const { sessionId, blockId } = await seedThinTree(db);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      tagKnowledgeFn: proposeChildKc('《论语》句子翻译'),
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(1);
    expect(result.routed_to_review).toBe(0);

    // A child KC was created under the subject root — live (not archived) + approved.
    const children = await db
      .select()
      .from(knowledge)
      .where(eq(knowledge.parent_id, 'seed:wenyan:root'));
    expect(children).toHaveLength(1);
    const newKc = children[0];
    expect(newKc.name).toBe('《论语》句子翻译');
    expect(newKc.approval_status).toBe('approved');
    expect(newKc.archived_at).toBeNull();
    expect(newKc.proposed_by_ai).toBe(true);

    // tagKnowledge's audit trail is an AUDIT-ONLY event (distinct action
    // 'experimental:auto_tag_kc_created', subject_kind='knowledge') recording the already-applied
    // KC id — NOT a pending/acceptable propose-event.
    const auditEvents = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:auto_tag_kc_created'),
          eq(event.subject_kind, 'knowledge'),
        ),
      );
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.subject_id).toBe(newKc.id);
    expect((auditEvents[0]?.payload as Record<string, unknown>).auto_created_kc_id).toBe(newKc.id);

    // No `propose` knowledge event (the inbox would surface it as pending → re-apply → duplicate).
    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge')));
    expect(proposeEvents).toHaveLength(0);

    // The materialized question attributes to the new KC + is placement-answerable. P3: NO
    // reference answer is synthesized (block.reference_md was null → reference_md stays null).
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(1);
    const q = questions[0];
    expect(q.knowledge_ids).toEqual([newKc.id]);
    expect(q.draft_status).toBe('active');
    expect(q.reference_md).toBeNull();

    // The block flipped to 'auto_enrolled' + linked to the question.
    const blocks = await db.select().from(question_block).where(eq(question_block.id, blockId));
    expect(blocks[0]?.status).toBe('auto_enrolled');
    expect(blocks[0]?.imported_question_id).toBe(q.id);
  });

  // The tagKnowledge audit trail must NEVER surface as a pending/acceptable proposal.
  it('tagKnowledge audit trail is NOT a pending proposal', async () => {
    const db = testDb();
    const { sessionId } = await seedThinTree(db);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      tagKnowledgeFn: proposeChildKc('《论语》句子翻译'),
    });
    expect(result.enrolled).toBe(1);

    const kcCount = (
      await db.select().from(knowledge).where(eq(knowledge.parent_id, 'seed:wenyan:root'))
    ).length;
    expect(kcCount).toBe(1);

    // The pending proposal inbox does NOT surface the tag KC create.
    const pending = await listProposalInboxRows(db, { status: 'pending' });
    expect(pending).toHaveLength(0);

    // The audit event itself is not addressable as a proposal.
    const auditEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:auto_tag_kc_created'));
    expect(auditEvents).toHaveLength(1);
    expect(await getProposalInboxRow(db, auditEvents[0].id)).toBeNull();
  });

  // tagKnowledge MATCH: an existing in-subject KC is matched → the question attributes to it, NO
  // new KC minted, NO audit event.
  it('tagKnowledge MATCH: attributes the existing KC, mints nothing', async () => {
    const db = testDb();
    const { sessionId } = await seed(db); // seeds k1 (domain wenyan)

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      tagKnowledgeFn: matchK1,
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(2);
    // No new KC under any root (matchK1 attributes the seeded k1).
    const questions = await db.select().from(question);
    expect(questions.every((q) => q.knowledge_ids.includes('k1'))).toBe(true);
    // No tag audit event (MATCH never mints).
    const auditEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:auto_tag_kc_created'));
    expect(auditEvents).toHaveLength(0);
  });

  // A tagKnowledge outage (provider down / missing seed root → a thrown error) must route the
  // block to review (upload not lost), no throw out of the runner, nothing enrolled.
  it('tagKnowledge outage: routes to review, no throw, no question, block stays draft', async () => {
    const db = testDb();
    const { sessionId, blockId } = await seedThinTree(db);

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      tagKnowledgeFn: async () => {
        throw new Error('tagKnowledge: missing seed root / provider down');
      },
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(0);
    expect(result.routed_to_review).toBe(1);
    // No KC created beyond the seed root, no question — the block stays draft for human review.
    const children = await db
      .select()
      .from(knowledge)
      .where(eq(knowledge.parent_id, 'seed:wenyan:root'));
    expect(children).toHaveLength(0);
    expect(await db.select().from(question)).toHaveLength(0);
    const blocks = await db.select().from(question_block).where(eq(question_block.id, blockId));
    expect(blocks[0]?.status).toBe('draft');
  });

  // tagKnowledge does NOT fire in observe mode (zero mutation): observe keeps the old grid-prefill
  // TaggingTask, so the tagKnowledge stub is never consulted and no KC is minted.
  it('tagKnowledge does NOT fire in observe mode (zero mutation)', async () => {
    const db = testDb();
    const { sessionId } = await seedThinTree(db);

    let tagCalled = false;
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: {}, // enroll OFF, observe ON (default) — must NOT run tagKnowledge / mutate
      runTaggingFn: highConfidenceTagging,
      tagKnowledgeFn: async (deps, input) => {
        tagCalled = true;
        return proposeChildKc('x')(deps, input);
      },
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(0);
    expect(tagCalled).toBe(false);
    // No child KC, no question — observe stays zero-mutation.
    const children = await db
      .select()
      .from(knowledge)
      .where(eq(knowledge.parent_id, 'seed:wenyan:root'));
    expect(children).toHaveLength(0);
    expect(await db.select().from(question)).toHaveLength(0);
  });

  // P3 batch cache: two sibling blocks both PROPOSE the same KC name → the unified per-run
  // batchCache (threaded by runAutoEnrollForSession) makes the second reuse the first's id, so
  // ONE KC is minted, not two. We assert via the REAL tagKnowledge default (a stub embedFn so no
  // model runs) to exercise the actual cache threading, not a hand-rolled stub.
  it('batch cache: sibling blocks proposing the same KC reuse one minted id (one KC, not two)', async () => {
    const db = testDb();
    // Thin tree with seed:wenyan:root + TWO draft blocks.
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'seed:wenyan:root',
      name: '文言文',
      domain: 'wenyan',
      parent_id: null,
      archived_at: null,
      proposed_by_ai: false,
      approval_status: 'approved',
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
        structured: structured(`翻译题 ${id}`),
        figures: [],
        layout_quality: 'structured' as const,
        image_refs: [],
        crop_refs: [],
        visual_complexity: 'low' as const,
        extraction_confidence: 1,
        status: 'draft' as const,
        reference_md: null,
        knowledge_hint: '论语',
        merged_from_block_ids: [],
        created_at: now,
        updated_at: now,
        version: 0,
      })),
    );

    // Use the REAL tagKnowledge default but stub its model seams: an embedFn returning an
    // orthogonal vector (→ no match → PROPOSE) + a nameKcFn returning a FIXED name (so both
    // siblings propose the same name → the batchCache dedups the second).
    const { tagKnowledge } = await import('@/capabilities/knowledge/server/tag-knowledge');
    const fixedVec = new Array<number>(1024).fill(0);
    fixedVec[3] = 1; // orthogonal to the root's seeded embedding (none here → no candidates anyway)
    const tagKnowledgeFn: RunAutoEnrollParams['tagKnowledgeFn'] = (deps, input) =>
      tagKnowledge(
        {
          ...deps,
          embedFn: async () => fixedVec,
          nameKcFn: async () => ({ kc_name: '《论语》句子翻译' }),
        },
        input,
      );

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' },
      tagKnowledgeFn,
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(2);
    // Exactly ONE KC minted under the root (the second sibling reused the first via the cache).
    const children = await db
      .select()
      .from(knowledge)
      .where(eq(knowledge.parent_id, 'seed:wenyan:root'));
    expect(children).toHaveLength(1);
    // Both questions attribute to that same single KC.
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(2);
    expect(questions.every((q) => q.knowledge_ids[0] === children[0].id)).toBe(true);
    // Exactly one audit event (one mint).
    const auditEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:auto_tag_kc_created'));
    expect(auditEvents).toHaveLength(1);
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
    const { buildAutoEnrollHandler } = await import('@/capabilities/ingestion/jobs/auto_enroll');
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
      tagKnowledgeFn: matchK1,
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
      tagKnowledgeFn: matchK1,
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
      tagKnowledgeFn: matchK1,
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
      tagKnowledgeFn: matchK1,
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

// =============================================================================
// YUK-482 cut ④ — ingestion student-answer grading. A block carrying student work
// (handwriting / VLM student_answer_present) is graded WHOLE-PAGE via the existing
// multimodal_direct judge → a real graded attempt → 错因 + θ̂. Dark-shippable behind
// WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED (default OFF → byte-identical today).
// =============================================================================

/** A standalone structured node carrying Tencent handwriting evidence (student work). */
function structuredWithHandwriting(prompt: string): StructuredQuestionT {
  return {
    id: createId(),
    role: 'standalone',
    prompt_text: prompt,
    source: 'tencent_ocr',
    extraction_evidence: {
      handwriting: [{ text: 'ignored-pixels', bbox: { x: 0, y: 0, width: 0.1, height: 0.1 } }],
    },
  };
}

/**
 * Seed an extracted ingestion session with ONE draft block that carries student
 * work (handwriting evidence). source_asset_ids = the whole page asset.
 */
async function seedStudentWork(
  db: ReturnType<typeof testDb>,
): Promise<{ sessionId: string; blockId: string }> {
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
    source_asset_ids: ['page_asset_1'],
    entrypoint: 'vision_paper',
    warnings: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const blockId = createId();
  await db.insert(question_block).values({
    id: blockId,
    ingestion_session_id: sessionId,
    source_document_id: null,
    source_asset_ids: ['page_asset_1'],
    page_spans: [],
    structured: structuredWithHandwriting('下列句中「之」的用法'),
    reference_md: '参考答案',
    figures: [],
    layout_quality: 'structured',
    image_refs: ['fig_asset_1'],
    crop_refs: [],
    visual_complexity: 'low',
    extraction_confidence: 1,
    status: 'draft',
    knowledge_hint: '之',
    merged_from_block_ids: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return { sessionId, blockId };
}

/**
 * YUK-487 — seed an extracted session with ONE 'glm_ocr'-fallback block (VLM
 * StructureTask down): NO handwriting evidence + NO student_answer_present,
 * source='glm_ocr'. Handwriting was NEVER assessed, so detectStudentWork returns
 * false UNINFORMATIVELY — the exact case where the old gate wrongly skipped grading.
 */
async function seedGlmFallbackNoHandwriting(
  db: ReturnType<typeof testDb>,
): Promise<{ sessionId: string; blockId: string }> {
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
    source_asset_ids: ['page_asset_1'],
    entrypoint: 'vision_paper',
    warnings: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const blockId = createId();
  await db.insert(question_block).values({
    id: blockId,
    ingestion_session_id: sessionId,
    source_document_id: null,
    source_asset_ids: ['page_asset_1'],
    page_spans: [],
    structured: {
      id: createId(),
      role: 'standalone',
      prompt_text: '计算下列各式的值',
      source: 'glm_ocr',
    },
    reference_md: '参考答案',
    figures: [],
    layout_quality: 'structured',
    image_refs: ['fig_asset_1'],
    crop_refs: [],
    visual_complexity: 'low',
    extraction_confidence: 1,
    status: 'draft',
    knowledge_hint: '之',
    merged_from_block_ids: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return { sessionId, blockId };
}

const gradeFailure: GradeStudentAnswerFn = async () => ({
  coarse_outcome: 'incorrect',
  confidence: 0.95,
});
const gradeCorrect: GradeStudentAnswerFn = async () => ({
  coarse_outcome: 'correct',
  confidence: 0.95,
});
const gradeLowConfidence: GradeStudentAnswerFn = async () => ({
  coarse_outcome: 'incorrect',
  confidence: 0.4, // < default threshold 0.85 → YUK-485 review gate
});

describe('runAutoEnrollForSession — YUK-482 cut ④ student-answer grading', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ---------------------------------------------------------------------------
  // Dark default: grading flag OFF → NO judge call, today's text-draft path.
  // (enroll FLAG on so the block enrolls — but via the unanswered text path, NOT
  // a graded attempt; the grader is never called.)
  // ---------------------------------------------------------------------------
  it('grading flag OFF (default): no judge call, text-draft path (byte-identical)', async () => {
    const db = testDb();
    const { sessionId } = await seedStudentWork(db);

    const gradeStudentAnswerFn = vi.fn(gradeFailure);
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true' }, // GRADE_FLAG unset → grading OFF
      tagKnowledgeFn: matchK1,
      gradeStudentAnswerFn,
    });

    expect(result.status).toBe('completed');
    // The grader is NEVER consulted on the dark default.
    expect(gradeStudentAnswerFn).not.toHaveBeenCalled();
    // The block still enrolls (enroll FLAG on) but via the text path: no
    // student-graded attempt (no wrong_answer_md → unanswered/open_question).
    const attempts = await db.select().from(event).where(eq(event.action, 'attempt'));
    expect(attempts).toHaveLength(0);
    const records = await db.select().from(learning_record);
    expect(records.every((r) => r.kind === 'open_question')).toBe(true);
    // No θ̂ written on the text path.
    const mastery = await db.select().from(mastery_state);
    expect(mastery).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Flag ON + student work + confident FAILURE verdict → graded attempt synthesized:
  // outcome from verdict, answerImageRefs = source_asset_ids, attribution_followup
  // enqueued, updateThetaForAttempt called once keyed on the KC.
  // ---------------------------------------------------------------------------
  it('flag ON + confident failure: graded attempt + attribution + θ̂', async () => {
    const db = testDb();
    const { sessionId, blockId } = await seedStudentWork(db);

    const gradeStudentAnswerFn = vi.fn<GradeStudentAnswerFn>(gradeFailure);
    const enqueueAttributionFollowupFn = vi.fn<(id: string) => Promise<void>>(async () => {});
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true', [GRADE_FLAG]: 'true' },
      tagKnowledgeFn: matchK1,
      gradeStudentAnswerFn,
      enqueueAttributionFollowupFn,
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(1);
    expect(gradeStudentAnswerFn).toHaveBeenCalledTimes(1);
    // The grader received the whole-page asset ids as the student images.
    const gradeCall = gradeStudentAnswerFn.mock.calls[0]?.[0];
    expect(gradeCall?.studentImageRefs).toEqual(['page_asset_1']);

    // A real failure attempt event (NOT the unanswered text path).
    const attempts = await db.select().from(event).where(eq(event.action, 'attempt'));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('failure');
    const attemptPayload = attempts[0]?.payload as Record<string, unknown>;
    // answer_md empty (handwriting stays pixels), answer images = page assets.
    expect(attemptPayload.answer_md).toBe('');
    expect(attemptPayload.answer_image_refs).toEqual(['page_asset_1']);
    expect(attemptPayload.generated_by).toBe('workflow_judge');

    // mistake record (failure → kind='mistake').
    const records = await db.select().from(learning_record);
    expect(records[0]?.kind).toBe('mistake');

    // attribution_followup enqueued for the failure with the attempt event id.
    expect(enqueueAttributionFollowupFn).toHaveBeenCalledTimes(1);
    expect(enqueueAttributionFollowupFn.mock.calls[0]?.[0]).toBe(attempts[0]?.id);

    // θ̂ written for the question's primary KC (k1). mastery_state keys KC
    // granularity on (subject_kind='knowledge', subject_id=kc). (updateThetaForAttempt
    // also writes a per-domain θ_global row under a distinct subject_kind when
    // HIERARCHICAL_ELO_ENABLED — same as paper-submit; we assert the KC row exists.)
    const masteryKc = await db
      .select()
      .from(mastery_state)
      .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, 'k1')));
    expect(masteryKc).toHaveLength(1);
    expect(masteryKc[0]?.evidence_count).toBeGreaterThan(0);

    // Question metadata carries the student-graded traceability stamp.
    const questions = await db.select().from(question);
    const meta = questions[0]?.metadata as { workflow_judge?: Record<string, unknown> } | null;
    expect(meta?.workflow_judge?.student_answer_graded).toBe(true);
    expect(meta?.workflow_judge?.student_grade_confidence).toBe(0.95);

    // Block flipped to auto_enrolled.
    const blocks = await db.select().from(question_block).where(eq(question_block.id, blockId));
    expect(blocks[0]?.status).toBe('auto_enrolled');
  });

  // ---------------------------------------------------------------------------
  // Flag ON + confident CORRECT verdict → success attempt, NO attribution, θ̂ written.
  // ---------------------------------------------------------------------------
  it('flag ON + confident correct: success attempt, no attribution, θ̂ written', async () => {
    const db = testDb();
    const { sessionId } = await seedStudentWork(db);

    const gradeStudentAnswerFn = vi.fn(gradeCorrect);
    const enqueueAttributionFollowupFn = vi.fn<(id: string) => Promise<void>>(async () => {});
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true', [GRADE_FLAG]: 'true' },
      tagKnowledgeFn: matchK1,
      gradeStudentAnswerFn,
      enqueueAttributionFollowupFn,
    });

    expect(result.enrolled).toBe(1);
    const attempts = await db.select().from(event).where(eq(event.action, 'attempt'));
    expect(attempts[0]?.outcome).toBe('success');
    // success → worked_example record, NO attribution_followup.
    const records = await db.select().from(learning_record);
    expect(records[0]?.kind).toBe('worked_example');
    expect(enqueueAttributionFollowupFn).not.toHaveBeenCalled();
    // θ̂ still written for the success evidence (KC row exists).
    const masteryKc = await db
      .select()
      .from(mastery_state)
      .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, 'k1')));
    expect(masteryKc).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // YUK-485 gate: low-confidence verdict (< threshold) → NO graded attempt, block
  // stays draft, routed to review.
  // ---------------------------------------------------------------------------
  it('flag ON + low-confidence verdict: no graded attempt, block stays draft (YUK-485)', async () => {
    const db = testDb();
    const { sessionId, blockId } = await seedStudentWork(db);

    const gradeStudentAnswerFn = vi.fn(gradeLowConfidence);
    const enqueueAttributionFollowupFn = vi.fn<(id: string) => Promise<void>>(async () => {});
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true', [GRADE_FLAG]: 'true' },
      tagKnowledgeFn: matchK1,
      gradeStudentAnswerFn,
      enqueueAttributionFollowupFn,
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(0);
    expect(result.routed_to_review).toBe(1);
    // Judge ran, but no downstream synthesis.
    expect(gradeStudentAnswerFn).toHaveBeenCalledTimes(1);
    expect(enqueueAttributionFollowupFn).not.toHaveBeenCalled();
    expect(await db.select().from(event).where(eq(event.action, 'attempt'))).toHaveLength(0);
    expect(await db.select().from(question)).toHaveLength(0);
    expect(await db.select().from(mastery_state)).toHaveLength(0);
    // Block untouched — still draft for human review.
    const blocks = await db.select().from(question_block).where(eq(question_block.id, blockId));
    expect(blocks[0]?.status).toBe('draft');
  });

  // ---------------------------------------------------------------------------
  // Flag ON + NO student work → no judge call, today's text path.
  // ---------------------------------------------------------------------------
  it('flag ON + no student work: no judge call, text path', async () => {
    const db = testDb();
    // seedAnswered seeds a block WITHOUT handwriting evidence / student_answer_present.
    const { sessionId } = await seedAnswered(db);

    const gradeStudentAnswerFn = vi.fn(gradeFailure);
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true', [GRADE_FLAG]: 'true' },
      tagKnowledgeFn: matchK1,
      gradeStudentAnswerFn,
    });

    expect(result.status).toBe('completed');
    // Detection negative → grader never called.
    expect(gradeStudentAnswerFn).not.toHaveBeenCalled();
    // No θ̂ (text path does not write it).
    expect(await db.select().from(mastery_state)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // YUK-487 — fail-OPEN when extraction did NOT assess handwriting. A 'glm_ocr'
  // fallback block (VLM StructureTask down) carries no handwriting flag, so the OLD
  // gate (detectStudentWork only) skipped the judge despite possible real handwriting.
  // The fix grades anyway and lets the judge be the detector.
  // ---------------------------------------------------------------------------
  it('flag ON + glm_ocr fallback, no handwriting flag: fail-OPEN → judge IS called (YUK-487)', async () => {
    const db = testDb();
    const { sessionId } = await seedGlmFallbackNoHandwriting(db);

    const gradeStudentAnswerFn = vi.fn(gradeCorrect);
    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      subjectId: 'wenyan',
      env: { [FLAG]: 'true', [GRADE_FLAG]: 'true' },
      tagKnowledgeFn: matchK1,
      gradeStudentAnswerFn,
    });

    expect(result.status).toBe('completed');
    // glm_ocr never assessed handwriting → detectStudentWork's false is uninformative →
    // fail-open → the whole-page judge IS invoked (pre-fix it was skipped).
    expect(gradeStudentAnswerFn).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // CRITICAL (independent review): exercise the REAL default grader
  // (defaultGradeStudentAnswer — NOT an injected gradeStudentAnswerFn stub) and
  // prove the vision judge actually runs on the page image. We seam only the
  // runMultimodalDirectJudge LLM (gradeRunTaskFn) + R2 fetch (gradeImageFetchFn).
  //
  // The defect this catches that the stub-only suite can't: the prior code routed
  // through createDefaultJudgeInvoker().invoke() → resolveQuestionJudgeRoute, which
  // for a wenyan short_answer block (general profile, no multimodal_direct in
  // preferredRoutes) resolves to `semantic` — a TEXT route that ignores
  // student_image_refs and judges an empty answer_md. The vision judge would never
  // see the handwriting. This test FAILS against that code (the stubbed
  // MultimodalDirectJudgeTask runTask is never called; a semantic-task runTask would
  // be) and PASSES after the direct runMultimodalDirectJudge call.
  // ---------------------------------------------------------------------------
  it('REAL default grader runs the vision judge on the page image (not a text route)', async () => {
    const db = testDb();
    const { sessionId } = await seedStudentWork(db);

    // The runMultimodalDirectJudge LLM seam. It is ONLY reached on the
    // multimodal_direct path; if route resolution sent us to `semantic`, this kind
    // would be a semantic task and this stub would never fire for
    // 'MultimodalDirectJudgeTask'. Capture every call to assert the route + images.
    const runTaskCalls: Array<{
      kind: string;
      images: Array<{ data: string; mediaType: string }>;
      textPayload: string;
    }> = [];
    const gradeRunTaskFn = vi.fn(
      async (
        kind: string,
        input: { text: string; images: Array<{ data: string; mediaType: string }> } | unknown,
      ): Promise<{ text: string }> => {
        const typed = input as {
          text: string;
          images: Array<{ data: string; mediaType: string }>;
        };
        runTaskCalls.push({ kind, images: typed.images ?? [], textPayload: typed.text });
        return {
          text: JSON.stringify({
            coarse_outcome: 'incorrect',
            score: 0,
            feedback_md: '判分：作答有误',
            evidence: { observed_md: '看到手写作答', matched_points: [], missing_points: [] },
            confidence: 0.95,
          }),
        };
      },
    );
    // The R2 image-fetch seam — return one fake image per requested asset id so we
    // can assert the page asset reached the vision payload as a real image.
    const imageFetchCalls: string[][] = [];
    const gradeImageFetchFn = vi.fn(
      async (assetIds: string[]): Promise<Array<{ data: string; mediaType: string }>> => {
        imageFetchCalls.push(assetIds);
        return assetIds.map((id) => ({ data: `b64-${id}`, mediaType: 'image/png' }));
      },
    );

    const result = await runAutoEnrollForSession({
      db,
      sessionId,
      // Deliberately NOT 'physics': wenyan would resolve to `semantic` via the
      // invoker — proving the direct call ignores preferredRoutes.
      subjectId: 'wenyan',
      env: { [FLAG]: 'true', [GRADE_FLAG]: 'true' },
      tagKnowledgeFn: matchK1,
      // NO gradeStudentAnswerFn → the production defaultGradeStudentAnswer runs.
      gradeRunTaskFn,
      gradeImageFetchFn,
    });

    expect(result.status).toBe('completed');
    expect(result.enrolled).toBe(1);

    // (a) The vision judge actually ran: the MultimodalDirectJudgeTask runTask fired
    // with the page image present (NOT a text-only route, which never calls this kind).
    const visionCalls = runTaskCalls.filter((c) => c.kind === 'MultimodalDirectJudgeTask');
    expect(visionCalls).toHaveLength(1);
    // The whole page asset reached the LLM as a real image (handwriting pixels).
    expect(visionCalls[0]?.images).toContainEqual({
      data: 'b64-page_asset_1',
      mediaType: 'image/png',
    });
    // The student-image refs were fetched (the page asset, NOT only the prompt figure).
    expect(imageFetchCalls).toContainEqual(['page_asset_1']);
    // answer_md is empty in the vision payload — handwriting stays pixels, never
    // transcribed into the text answer (would be the text-route failure mode).
    const visionPayload = JSON.parse(visionCalls[0]?.textPayload ?? '{}') as {
      student_image_refs?: string[];
      student_final_answer_text?: string;
    };
    expect(visionPayload.student_image_refs).toEqual(['page_asset_1']);
    expect(visionPayload.student_final_answer_text).toBeUndefined();

    // (b) It did NOT fall through to a text route: no semantic/other text task fired.
    expect(runTaskCalls.every((c) => c.kind === 'MultimodalDirectJudgeTask')).toBe(true);

    // The graded verdict (incorrect, conf 0.95) drove a real failure attempt.
    const attempts = await db.select().from(event).where(eq(event.action, 'attempt'));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('failure');
  });

  // ---------------------------------------------------------------------------
  // detectStudentWork — pure detection (no DB): Tencent handwriting OR VLM
  // student_answer_present → true; neither → false.
  // ---------------------------------------------------------------------------
  describe('detectStudentWork', () => {
    it('Tencent handwriting evidence present → true', () => {
      expect(detectStudentWork({ structured: structuredWithHandwriting('题面') })).toBe(true);
    });

    it('VLM student_answer_present → true', () => {
      const node: StructuredQuestionT = {
        id: createId(),
        role: 'standalone',
        prompt_text: '题面',
        source: 'vlm_structure',
        student_answer_present: true,
      };
      expect(detectStudentWork({ structured: node })).toBe(true);
    });

    it('VLM student_answer_present on a nested sub → true (walks the tree)', () => {
      const stem: StructuredQuestionT = {
        id: createId(),
        role: 'stem',
        prompt_text: 'passage',
        source: 'vlm_structure',
        sub_questions: [
          { id: createId(), role: 'sub', prompt_text: '小问1', source: 'vlm_structure' },
          {
            id: createId(),
            role: 'sub',
            prompt_text: '小问2',
            source: 'vlm_structure',
            student_answer_present: true,
          },
        ],
      };
      expect(detectStudentWork({ structured: stem })).toBe(true);
    });

    it('neither signal → false', () => {
      expect(detectStudentWork({ structured: structured('纯题面无作答') })).toBe(false);
    });

    it('no structured tree → false', () => {
      expect(detectStudentWork({ structured: null })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // YUK-487 — extractionAssessedHandwriting + shouldGradeStudentWork (pure, no DB).
  // ---------------------------------------------------------------------------
  describe('extractionAssessedHandwriting (YUK-487)', () => {
    it('vlm_structure → true (StructureTask assesses handwriting)', () => {
      expect(extractionAssessedHandwriting({ structured: structured('题面') })).toBe(true);
    });
    it('tencent_ocr → true (Tencent sets handwriting evidence)', () => {
      expect(extractionAssessedHandwriting({ structured: structuredWithHandwriting('题面') })).toBe(
        true,
      );
    });
    it('glm_ocr fallback → false (handwriting never assessed)', () => {
      const node: StructuredQuestionT = {
        id: createId(),
        role: 'standalone',
        prompt_text: '题面',
        source: 'glm_ocr',
      };
      expect(extractionAssessedHandwriting({ structured: node })).toBe(false);
    });
    it('no structured tree → false', () => {
      expect(extractionAssessedHandwriting({ structured: null })).toBe(false);
    });
  });

  describe('shouldGradeStudentWork (YUK-487 fail-open gate)', () => {
    it('handwriting flagged → grade (regardless of source)', () => {
      expect(shouldGradeStudentWork({ structured: structuredWithHandwriting('题面') })).toBe(true);
    });
    it('vlm_structure assessed + no handwriting → SKIP (trusted negative, cost guard)', () => {
      expect(shouldGradeStudentWork({ structured: structured('纯题面无作答') })).toBe(false);
    });
    it('glm_ocr fallback + no handwriting → GRADE (fail-open; the YUK-487 fix)', () => {
      const node: StructuredQuestionT = {
        id: createId(),
        role: 'standalone',
        prompt_text: '题面',
        source: 'glm_ocr',
      };
      // pre-fix the gate (detectStudentWork only) would have skipped this block:
      expect(detectStudentWork({ structured: node })).toBe(false);
      expect(shouldGradeStudentWork({ structured: node })).toBe(true);
    });
    it('manual (non-scan source) + no handwriting → SKIP (not diverted from auto-enroll)', () => {
      const node: StructuredQuestionT = {
        id: createId(),
        role: 'standalone',
        prompt_text: '题面',
        source: 'manual',
      };
      expect(shouldGradeStudentWork({ structured: node })).toBe(false);
    });
    it('no structured tree (absent source, non-scan) → SKIP (no fail-open; stays on tagging path)', () => {
      expect(shouldGradeStudentWork({ structured: null })).toBe(false);
    });
  });
});
