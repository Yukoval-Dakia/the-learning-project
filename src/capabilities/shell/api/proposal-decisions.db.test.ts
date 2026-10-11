import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { event, knowledge, question_block, source_document } from '@/db/schema';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { backfillQuestionBlockGenesis } from '../../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './proposal-decisions';

const KNOWLEDGE_BASE = {
  domain: 'yuwen',
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

async function seedKnowledge(ids: string[]): Promise<void> {
  const db = testDb();
  const now = new Date();
  for (const id of ids) {
    await db.insert(knowledge).values({
      id,
      name: id,
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...KNOWLEDGE_BASE,
    });
  }
}

async function seedEdgeProposal(id = 'edge_p1'): Promise<void> {
  await seedKnowledge(['k1', 'k2']);
  await writeAiProposal(testDb(), {
    id,
    payload: {
      kind: 'knowledge_edge',
      target: { subject_kind: 'knowledge_edge', subject_id: null },
      reason_md: 'k1 unlocks k2',
      evidence_refs: [{ kind: 'event', id: 'evt_1' }],
      proposed_change: {
        from_knowledge_id: 'k1',
        to_knowledge_id: 'k2',
        relation_type: 'prerequisite',
        weight: 0.7,
      },
    },
  });
}

function decide(id: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://test/api/proposals/${id}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { id },
  );
}

type DecisionBody = {
  proposal_id: string;
  proposal_kind: string;
  decision: string;
  decision_event_id: string | null;
  proposal_status: string;
  created: boolean;
  idempotent: boolean;
  result: unknown;
};

// ── YUK-1404 block_merge fixtures (mirror the ingestion appliers' seeding:
// draft question_block rows with admission-provable provenance) ──

let blockOrdinal = 0;

async function seedSourceDocument(id = 'doc-1'): Promise<void> {
  const now = new Date();
  await testDb().insert(source_document).values({
    id,
    source_asset_ids: [],
    provenance: {},
    created_at: now,
    updated_at: now,
  });
}

async function seedDraftBlock(opts: {
  sessionId: string;
  nodeId: string;
  promptText: string;
  status?: string;
  pageIndex: number;
}): Promise<string> {
  const db = testDb();
  const blockId = createId();
  const now = new Date();
  const ordinal = blockOrdinal;
  blockOrdinal += 1;
  await db.insert(question_block).values({
    id: blockId,
    ingestion_session_id: opts.sessionId,
    source_document_id: 'doc-1',
    source_asset_ids: [],
    page_spans: [{ page_index: opts.pageIndex, bbox: { x: 0, y: 0, width: 1, height: 1 } }],
    structured: { id: opts.nodeId, role: 'standalone', prompt_text: opts.promptText },
    figures: [],
    layout_quality: 'structured',
    image_refs: [],
    crop_refs: [],
    visual_complexity: 'low',
    extraction_confidence: 1,
    status: opts.status ?? 'draft',
    knowledge_hint: null,
    merged_from_block_ids: [],
    imported_question_id: null,
    imported_attempt_event_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
    ordinal,
  });
  await backfillQuestionBlockGenesis(db, now);
  return blockId;
}

async function seedBlockMergeProposal(opts: {
  proposalId: string;
  sessionId: string;
  primaryBlockId: string;
  mergeBlockIds: string[];
}): Promise<void> {
  await writeAiProposal(testDb(), {
    id: opts.proposalId,
    payload: {
      kind: 'block_merge',
      target: { subject_kind: 'question_block', subject_id: opts.primaryBlockId },
      reason_md: '连续编号，承接前题',
      evidence_refs: [],
      proposed_change: {
        primary_block_id: opts.primaryBlockId,
        merge_block_ids: opts.mergeBlockIds,
        ingestion_session_id: opts.sessionId,
        continuity_signal: 'numbering',
      },
      cooldown_key: `block_merge:${opts.sessionId}:${opts.primaryBlockId}:${opts.mergeBlockIds.join(',')}`,
    },
  });
}

describe('POST /api/proposals/[id]/decisions', () => {
  beforeEach(async () => {
    blockOrdinal = 0;
    await resetDb();
  });

  it('replays the same normalized decision without creating another event', async () => {
    await seedEdgeProposal();

    const first = await decide('edge_p1', { decision: 'accept' });
    const firstBody = (await first.json()) as DecisionBody;
    const replay = await decide('edge_p1', { decision: 'accept' });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as DecisionBody;
    expect(replayBody).toMatchObject({
      decision_event_id: firstBody.decision_event_id,
      created: false,
      idempotent: true,
    });
    // YUK-681 P2: the decision-resource idempotent short-circuit is gone, so a same-decision
    // replay now falls through to the applier, whose idempotent branch returns its own result
    // (previously the short-circuit returned `result: null` before the applier ran). No new
    // rate event is written — the applier self-guards idempotency.
    expect(replayBody.result).toMatchObject({ kind: 'knowledge_edge', idempotent: true });

    const rateRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'edge_p1')));
    expect(rateRows).toHaveLength(1);
  });

  it('keeps change_type re-decision idempotent (200, not 409)', async () => {
    await seedEdgeProposal();

    const first = await decide('edge_p1', {
      decision: 'change_type',
      new_relation_type: 'related_to',
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as DecisionBody;
    expect(firstBody).toMatchObject({ decision: 'change_type', created: true, idempotent: false });

    // YUK-681 P2: only `accept` falls through to the applier now; change_type/reverse must keep
    // their same-decision idempotent replay served by the resource, because acceptAiProposal's
    // top guard is accept-only and would 409 them (Codex review on the first cut of this PR).
    const replay = await decide('edge_p1', {
      decision: 'change_type',
      new_relation_type: 'related_to',
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      decision_event_id: firstBody.decision_event_id,
      created: false,
      idempotent: true,
      result: null,
    });
  });

  it('models retract as a correction resource and makes retries idempotent', async () => {
    await seedEdgeProposal();
    expect((await decide('edge_p1', { decision: 'accept' })).status).toBe(201);

    const retract = await decide('edge_p1', {
      decision: 'retract',
      reason_md: '判断有误',
      affected_refs: [{ kind: 'question', id: 'q1' }],
    });
    expect(retract.status).toBe(201);
    const body = (await retract.json()) as DecisionBody;
    expect(body).toMatchObject({
      decision: 'retract',
      proposal_status: 'stale',
      created: true,
      idempotent: false,
    });

    const replay = await decide('edge_p1', { decision: 'retract' });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      decision_event_id: body.decision_event_id,
      created: false,
      idempotent: true,
    });

    const correctionRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'correct'), eq(event.subject_id, 'edge_p1')));
    expect(correctionRows).toHaveLength(1);
  });

  // ── YUK-1404 — block_merge decision contract: the narrow soft-stale member
  // (decision_event_id:null) vs the committed member (201 + Location, replay
  // 200 with the SAME immutable event). Irreversible-loss class invariants:
  // a skipped merge must never look decided, a real accept must stay
  // once-only. ──

  it('serves a soft-stale block_merge accept as 200 non-created with no Location and no decision event', async () => {
    const sessionId = createId();
    await seedSourceDocument();
    const primary = await seedDraftBlock({
      sessionId,
      nodeId: 'p',
      promptText: 'primary',
      pageIndex: 1,
    });
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: 'merge1',
      status: 'imported',
      pageIndex: 2,
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_http_stale',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    const res = await decide('block_merge_http_stale', { decision: 'accept', confirm_lossy: true });
    expect(res.status).toBe(200);
    // Never /api/events/null: the stale member carries no Location at all.
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as DecisionBody;
    expect(body).toMatchObject({
      proposal_id: 'block_merge_http_stale',
      proposal_kind: 'block_merge',
      decision: 'accept',
      decision_event_id: null,
      proposal_status: 'pending',
      created: false,
      idempotent: false,
      result: { kind: 'block_merge', stale: true, skip_reason: 'skipped:not_draft' },
    });

    // No acceptance event was written and no block was mutated — the
    // proposal is NOT resolved.
    const rateRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_http_stale')));
    expect(rateRows).toHaveLength(0);
    const primaryRow = (
      await testDb().select().from(question_block).where(eq(question_block.id, primary)).limit(1)
    )[0];
    expect(primaryRow.merged_from_block_ids).toEqual([]);
    expect(primaryRow.version).toBe(0);
  });

  // @invariant concurrency: replay returns the one committed merge decision without another merge
  // @fails-if return an invented decision id or repeat the merge; event identity and version assertions fail
  it('keeps the committed block_merge accept contract: 201 + Location, replay 200 reuses the same immutable event', async () => {
    const sessionId = createId();
    await seedSourceDocument();
    const primary = await seedDraftBlock({
      sessionId,
      nodeId: 'p',
      promptText: 'primary',
      pageIndex: 1,
    });
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: 'merge1',
      pageIndex: 2,
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_http_commit',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    const accept = await decide('block_merge_http_commit', {
      decision: 'accept',
      confirm_lossy: true,
    });
    expect(accept.status).toBe(201);
    const acceptBody = (await accept.json()) as DecisionBody;
    expect(accept.headers.get('location')).toBe(
      `/api/events/${encodeURIComponent(acceptBody.decision_event_id as string)}`,
    );
    expect(acceptBody).toMatchObject({
      proposal_kind: 'block_merge',
      decision: 'accept',
      proposal_status: 'accepted',
      created: true,
      idempotent: false,
    });

    // Same-decision replay: 200, non-created, SAME immutable event id.
    const replay = await decide('block_merge_http_commit', {
      decision: 'accept',
      confirm_lossy: true,
    });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as DecisionBody;
    expect(replayBody.decision_event_id).toBe(acceptBody.decision_event_id);
    expect(replayBody.created).toBe(false);
    expect(replayBody.idempotent).toBe(true);

    // Once-only: exactly one rate event for the proposal, and the merge
    // itself happened exactly once.
    const rateRows = await testDb()
      .select()
      .from(event)
      .where(
        and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_http_commit')),
      );
    expect(rateRows).toHaveLength(1);
    expect(acceptBody.decision_event_id).toBe(rateRows[0].id);
    const primaryRow = (
      await testDb().select().from(question_block).where(eq(question_block.id, primary)).limit(1)
    )[0];
    expect(primaryRow.merged_from_block_ids).toEqual([m1]);
    expect(primaryRow.version).toBe(1);
  });
});
