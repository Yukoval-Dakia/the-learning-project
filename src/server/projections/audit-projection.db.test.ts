// YUK-471 W1 PR-A2a — DB tests for the projection auditor (testcontainer).
//
// Tests the auditProjection FUNCTION (not the process exit). The fixture is a SMALL coherent
// world: a few `knowledge` rows + their genesis events + matching materialized_id_index
// entries (seeded via the backfill pipeline fns, so fold(genesis)==row by construction). The
// auditor must report CLEAN. Then we mutate a live row OUT-OF-BAND (a raw UPDATE that bypasses
// the projection) and assert the auditor flags exactly that id as DRIFT. A third case proves
// the allowlist suppresses a known drift.
//
// Hermetic: resetDb() in beforeEach. resetDb does NOT truncate materialized_id_index (no FK →
// not reached by CASCADE), so we truncate it explicitly to keep the reverse-index hermetic.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { artifact, event, knowledge, knowledge_edge, question_block } from '@/db/schema';
import { auditProjection } from '../../../scripts/audit-projection';
import {
  backfillArtifactGenesis,
  backfillKnowledgeEdgeGenesis,
  backfillKnowledgeGenesis,
  backfillQuestionBlockGenesis,
} from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { projectKnowledgeEdge } from './knowledge_edge';

const T0 = new Date('2026-06-01T00:00:00.000Z');

async function insertKnowledge(opts: {
  id: string;
  name?: string;
  domain?: string | null;
  parent_id?: string | null;
  version?: number;
}): Promise<void> {
  const db = testDb();
  await db.insert(knowledge).values({
    id: opts.id,
    name: opts.name ?? opts.id,
    domain: opts.domain ?? null,
    parent_id: opts.parent_id ?? null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    archived_at: null,
    created_at: T0,
    updated_at: T0,
    version: opts.version ?? 0,
  });
}

async function insertEdge(opts: {
  id: string;
  from: string;
  to: string;
  relation_type?: string;
  archived_at?: Date | null;
}): Promise<void> {
  const db = testDb();
  await db.insert(knowledge_edge).values({
    id: opts.id,
    from_knowledge_id: opts.from,
    to_knowledge_id: opts.to,
    relation_type: opts.relation_type ?? 'related_to',
    weight: 1,
    created_by: { by: 'user' },
    reasoning: null,
    created_at: T0,
    archived_at: opts.archived_at ?? null,
  });
}

// Seed a generate-create event for a PREREQUISITE edge (no genesis), so folding it re-runs the
// ADR-0034 topology gate against the live mesh. Materialize the row via the shell so the live
// row EQUALS fold(events) by construction (no hand-matched created_by).
async function seedGenerateCreatePrereq(opts: {
  edgeId: string;
  from: string;
  to: string;
}): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: `ev_gen_${opts.edgeId}`,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'dreaming',
    action: 'generate',
    subject_kind: 'knowledge_edge',
    subject_id: opts.edgeId,
    outcome: 'partial',
    payload: {
      edge_op: 'create',
      from_knowledge_id: opts.from,
      to_knowledge_id: opts.to,
      relation_type: 'prerequisite',
      weight: 1,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: T0,
  });
}

describe('auditProjection', () => {
  beforeEach(async () => {
    // materialized_id_index is now in ALL_TABLES (tests/helpers/db.ts), so resetDb
    // truncates the reverse-index too — no explicit truncate needed.
    await resetDb();
  });

  it('reports CLEAN when every live row is backed by a matching genesis event', async () => {
    const db = testDb();
    // A small coherent world: 3 knowledge rows + 1 edge.
    await insertKnowledge({ id: 'kn_a', name: 'A', domain: 'wenyan', parent_id: 'seed:root' });
    await insertKnowledge({ id: 'kn_b', name: 'B', parent_id: 'kn_a', version: 2 });
    await insertKnowledge({ id: 'kn_c', name: 'C' });
    await insertEdge({ id: 'ke_ab', from: 'kn_a', to: 'kn_b' });

    // Seed genesis events + index entries via the real backfill pipeline, so fold==row holds.
    await backfillKnowledgeGenesis(db, T0);
    await backfillKnowledgeEdgeGenesis(db, T0);

    const result = await auditProjection(db);
    expect(result.ok).toBe(true);
    expect(result.checkedNodes).toBe(3);
    expect(result.checkedEdges).toBe(1);
    expect(result.drift).toEqual([]);
    expect(result.allowed).toEqual([]);
  });

  it('reports CLEAN across a multi-edge world; the archived_at filter is LOAD-BEARING (archived reverse prerequisite must be excluded or folding the live one cycle-rejects)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'kn_a', name: 'A' });
    await insertKnowledge({ id: 'kn_b', name: 'B' });
    await insertKnowledge({ id: 'kn_c', name: 'C' });
    // Breadth: a live related_to edge (genesis-backfilled; topology ignores non-prerequisite).
    await insertEdge({ id: 'ke_ab', from: 'kn_a', to: 'kn_b' });
    // The LOAD-BEARING fixture: an ARCHIVED reverse PREREQUISITE c → a (genesis-backfilled →
    // fold(genesis)==archived row). It MUST be excluded from the once-fetched live mesh. If the
    // auditor's archived_at===null filter were broken (dropped / wrong sense), this c → a would
    // wrongly enter the prerequisite mesh and folding the live a → c below would see its reverse
    // → ADR-0034 direction_contradiction → foldKnowledgeEdge THROWS → auditProjection throws →
    // this test FAILS. So a wrong filter is caught here (unlike a non-prerequisite archived edge,
    // which topology ignores). This is what makes the filter provably correct at the auditor level.
    await insertEdge({
      id: 'ke_ca_arch',
      from: 'kn_c',
      to: 'kn_a',
      relation_type: 'prerequisite',
      archived_at: T0,
    });
    await backfillKnowledgeGenesis(db, T0);
    await backfillKnowledgeEdgeGenesis(db, T0);
    // A LIVE generate-create PREREQUISITE a → c added AFTER backfill (only the generate event, no
    // genesis), materialized via the shell so the live row EQUALS fold(events). Folding it re-runs
    // ADR-0034 topology against the auditor's once-fetched (filter-built) mesh — which, with a
    // correct filter, holds a → c (self) but NOT the archived reverse c → a, so the verdict is ok.
    await seedGenerateCreatePrereq({ edgeId: 'ke_ac_pre', from: 'kn_a', to: 'kn_c' });
    await projectKnowledgeEdge(db, 'ke_ac_pre');

    const result = await auditProjection(db);
    expect(result.ok).toBe(true);
    expect(result.drift).toEqual([]);
    expect(result.checkedNodes).toBe(3);
    // 3 edges: ke_ab (related_to), ke_ca_arch (archived prerequisite), ke_ac_pre (live prerequisite).
    expect(result.checkedEdges).toBe(3);
  });

  it('flags exactly the out-of-band-mutated row as DRIFT', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'kn_a', name: 'A', parent_id: 'seed:root' });
    await insertKnowledge({ id: 'kn_b', name: 'B', parent_id: 'kn_a' });
    await backfillKnowledgeGenesis(db, T0);

    // Sanity: clean before the out-of-band write.
    expect((await auditProjection(db)).ok).toBe(true);

    // Mutate kn_b's name DIRECTLY (bypassing the projection) — the genesis snapshot still says
    // 'B', so fold(events) for kn_b yields name='B' but the live row now says 'TAMPERED'.
    await db.update(knowledge).set({ name: 'TAMPERED' }).where(eq(knowledge.id, 'kn_b'));

    const result = await auditProjection(db);
    expect(result.ok).toBe(false);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.id).toBe('kn_b');
    expect(result.drift[0]?.subject_kind).toBe('knowledge');
    // the diff names the `name` column.
    expect(result.drift[0]?.diffs.some((d) => d.startsWith('name:'))).toBe(true);
    // kn_a is untouched → not in drift.
    expect(result.drift.some((r) => r.id === 'kn_a')).toBe(false);
  });

  it('a present live row whose events fold to null is DRIFT (stale row)', async () => {
    const db = testDb();
    // A live row with NO genesis event and NO creating events → fold yields null, but the row
    // is present → DRIFT (present → fold-null).
    await insertKnowledge({ id: 'kn_orphan', name: 'orphan' });

    const result = await auditProjection(db);
    expect(result.ok).toBe(false);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.id).toBe('kn_orphan');
    expect(result.drift[0]?.diffs.some((d) => d.includes('present → fold-null'))).toBe(true);
  });

  it('allowlist suppresses a known drifted id (reported as allowed, not a failure)', async () => {
    const db = testDb();
    await insertKnowledge({ id: 'kn_a', name: 'A' });
    await backfillKnowledgeGenesis(db, T0);
    await db.update(knowledge).set({ name: 'TAMPERED' }).where(eq(knowledge.id, 'kn_a'));

    const result = await auditProjection(db, {
      kn_a: {
        reason: 'test — known acceptable drift',
        resolves_when: { kind: 'manual', ref: 'test', expected_by: '2026-12-31' },
      },
    });
    expect(result.ok).toBe(true); // allowlisted → not a failure
    expect(result.drift).toEqual([]);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0]?.id).toBe('kn_a');
  });
});

// ── YUK-471 W3-C3 — artifact + question_block coverage in the audit:projection gate ──────────────
async function insertArtifactRow(id: string, title: string): Promise<void> {
  await testDb().insert(artifact).values({
    id,
    type: 'note_atomic',
    title,
    parent_artifact_id: null,
    knowledge_ids: [],
    intent_source: 'manual',
    source: 'manual',
    source_ref: null,
    body_blocks: null,
    attrs: {},
    tool_kind: null,
    tool_state: null,
    generation_status: 'ready',
    verification_status: 'not_required',
    verification_summary: null,
    generated_by: null,
    verified_by: null,
    history: [],
    archived_at: null,
    created_at: T0,
    updated_at: T0,
    version: 0,
  });
}

async function insertBlockRow(id: string): Promise<void> {
  await testDb()
    .insert(question_block)
    .values({
      id,
      ingestion_session_id: 'sess_1',
      source_document_id: null,
      source_asset_ids: [],
      page_spans: [],
      extracted_prompt_md: 'legacy prompt md', // legacy column — must NOT enter the fold (design §5.2)
      structured: { id, role: 'standalone', prompt_text: 'original' },
      figures: [],
      layout_quality: 'structured',
      reference_md: null,
      wrong_answer_md: null,
      image_refs: [],
      crop_refs: [],
      visual_complexity: 'low',
      extraction_confidence: 1,
      status: 'draft',
      knowledge_hint: null,
      merged_from_block_ids: [],
      imported_question_id: null,
      imported_attempt_event_id: null,
      created_at: T0,
      updated_at: T0,
      version: 0,
    });
}

describe('auditProjection — artifact + question_block (W3-C3)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('reports CLEAN when every artifact + question_block row is genesis-backfilled', async () => {
    const db = testDb();
    await insertArtifactRow('art_a', 'A');
    await insertArtifactRow('art_b', 'B');
    await insertBlockRow('qb_a');
    await backfillArtifactGenesis(db, T0);
    await backfillQuestionBlockGenesis(db, T0);

    const result = await auditProjection(db);
    expect(result.ok).toBe(true);
    expect(result.checkedArtifacts).toBe(2);
    expect(result.checkedQuestionBlocks).toBe(1);
    expect(result.drift).toEqual([]);
  });

  it('flags exactly the out-of-band-mutated artifact as DRIFT', async () => {
    const db = testDb();
    await insertArtifactRow('art_a', 'A');
    await insertArtifactRow('art_b', 'B');
    await backfillArtifactGenesis(db, T0);
    expect((await auditProjection(db)).ok).toBe(true);

    // Tamper art_b's title directly (bypass the projection) — fold(genesis) still says 'B'.
    await db.update(artifact).set({ title: 'TAMPERED' }).where(eq(artifact.id, 'art_b'));

    const result = await auditProjection(db);
    expect(result.ok).toBe(false);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.id).toBe('art_b');
    expect(result.drift[0]?.subject_kind).toBe('artifact');
    expect(result.drift[0]?.diffs.some((d) => d.startsWith('title:'))).toBe(true);
  });

  it('flags an out-of-band-mutated question_block as DRIFT; the legacy extracted_prompt_md change is INVISIBLE', async () => {
    const db = testDb();
    await insertBlockRow('qb_a');
    await backfillQuestionBlockGenesis(db, T0);
    expect((await auditProjection(db)).ok).toBe(true);

    // Mutating ONLY the legacy extracted_prompt_md is NOT drift (excluded from the fold, design §5.2).
    await db
      .update(question_block)
      .set({ extracted_prompt_md: 'changed legacy md' })
      .where(eq(question_block.id, 'qb_a'));
    expect((await auditProjection(db)).ok).toBe(true);

    // Mutating a fold-truth column (reference_md) IS drift.
    await db
      .update(question_block)
      .set({ reference_md: 'TAMPERED' })
      .where(eq(question_block.id, 'qb_a'));
    const result = await auditProjection(db);
    expect(result.ok).toBe(false);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.id).toBe('qb_a');
    expect(result.drift[0]?.subject_kind).toBe('question_block');
    expect(result.drift[0]?.diffs.some((d) => d.startsWith('reference_md:'))).toBe(true);
  });
});
