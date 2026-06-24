// YUK-96 P6/C — loadKnowledgeNodePage aggregator unit-level DB test.
//
// Verifies the server-side aggregate for the /knowledge/[id] node page:
// single-node metadata, mastery join, mesh neighbors, primary atomic,
// backlinks read-time filter (XC-5), timeline, and not-found path.

import { createKnowledgeEdge } from '@/capabilities/knowledge/server/edges';
import { artifact, artifact_block_ref, event, knowledge, learning_item } from '@/db/schema';
import { upsertMasteryState } from '@/server/mastery/state';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadKnowledgeNodePage } from './node-page';

const K_BASE = {
  domain: 'wenyan' as const,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

const A_BASE = {
  intent_source: 'test',
  source: 'test',
  verification_status: 'not_required',
};

async function seedKnowledge(id: string, opts: { name?: string; parent_id?: string | null } = {}) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: opts.name ?? id,
    parent_id: opts.parent_id ?? null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    ...K_BASE,
  });
}

async function seedAtomicArtifact(
  id: string,
  knowledgeId: string,
  bodyBlocks: unknown = null,
  genStatus = 'ready',
) {
  const db = testDb();
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type: 'note_atomic',
    title: `atomic-${id}`,
    knowledge_ids: [knowledgeId],
    body_blocks: bodyBlocks as never,
    generation_status: genStatus,
    archived_at: null,
    created_at: now,
    updated_at: now,
    ...A_BASE,
  });
}

async function seedEdge(
  from: string,
  to: string,
  relationType:
    | 'prerequisite'
    | 'related_to'
    | 'contrasts_with'
    | 'applied_in'
    | 'derived_from' = 'prerequisite',
) {
  const db = testDb();
  await createKnowledgeEdge(db, {
    from_knowledge_id: from,
    to_knowledge_id: to,
    relation_type: relationType,
  });
}

async function seedArchivedKnowledge(
  id: string,
  opts: { name?: string; parent_id?: string | null } = {},
) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: opts.name ?? id,
    parent_id: opts.parent_id ?? null,
    archived_at: now,
    created_at: now,
    updated_at: now,
    ...K_BASE,
  });
}

async function archiveKnowledge(id: string) {
  const db = testDb();
  await db
    .update(knowledge)
    .set({ archived_at: new Date(), updated_at: new Date() })
    .where(eq(knowledge.id, id));
}

async function seedLearningItem(
  id: string,
  primaryArtifactId: string,
  opts: { archived?: boolean } = {},
) {
  const db = testDb();
  const now = new Date();
  await db.insert(learning_item).values({
    id,
    source: 'learning_intent',
    title: `li-${id}`,
    content: '',
    knowledge_ids: [],
    primary_artifact_id: primaryArtifactId,
    status: 'pending',
    archived_at: opts.archived ? now : null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedSourceArtifact(id: string, knowledgeId: string, type = 'note_hub') {
  const db = testDb();
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type,
    title: `source-${id}`,
    knowledge_ids: [knowledgeId],
    generation_status: 'ready',
    archived_at: null,
    created_at: now,
    updated_at: now,
    ...A_BASE,
  });
}

async function seedBacklinkRef(fromArtifactId: string, toArtifactId: string, blockId: string) {
  const db = testDb();
  await db.insert(artifact_block_ref).values({
    from_artifact_id: fromArtifactId,
    from_block_id: blockId,
    to_artifact_id: toArtifactId,
    to_block_id: null,
    ref_kind: 'cross_link',
  });
}

async function seedEvent(id: string, knowledgeId: string, createdAt = new Date()) {
  const db = testDb();
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome: 'failure',
    payload: { referenced_knowledge_ids: [knowledgeId] },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: createdAt,
  });
}

describe('loadKnowledgeNodePage', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns null for unknown knowledge id', async () => {
    const db = testDb();
    const page = await loadKnowledgeNodePage(db, 'does_not_exist');
    expect(page).toBeNull();
  });

  it('returns null for archived knowledge id', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k-archived',
      name: 'archived',
      archived_at: now,
      created_at: now,
      updated_at: now,
      ...K_BASE,
    });
    const page = await loadKnowledgeNodePage(db, 'k-archived');
    expect(page).toBeNull();
  });

  it('returns basic node metadata for a node with no atomic / edges / events', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page).not.toBeNull();
    expect(page?.id).toBe('k1');
    expect(page?.name).toBe('虚词');
    expect(page?.effective_domain).toBe('wenyan');
    expect(page?.evidence_count).toBe(0);
    expect(page?.mastery).toBeNull();
    expect(page?.primary_atomic).toBeNull();
    expect(page?.notes).toHaveLength(0);
    expect(page?.mesh_neighbors).toHaveLength(0);
    expect(page?.backlinks).toHaveLength(0);
    expect(page?.timeline).toHaveLength(0);
  });

  it('lists all labeled notes (atomic/hub/long) in `notes`, atomic-first', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedAtomicArtifact('a1', 'k1');
    await seedSourceArtifact('h1', 'k1', 'note_hub');
    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.notes.map((n) => n.id)).toEqual(['a1', 'h1']);
    expect(page?.notes.map((n) => n.type)).toEqual(['note_atomic', 'note_hub']);
    // primary_atomic still surfaces the inline 节点简介 (the atomic).
    expect(page?.primary_atomic?.id).toBe('a1');
  });

  // ADR-0033 D5 — interactive artifacts surface in their own field and must
  // never leak into `notes` (the ADR-0027 note contract).
  it('lists labeled interactive artifacts in `interactive_artifacts`, not in `notes`', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedSourceArtifact('h1', 'k1', 'note_hub');
    await seedSourceArtifact('i1', 'k1', 'interactive');
    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.interactive_artifacts.map((n) => n.id)).toEqual(['i1']);
    expect(page?.interactive_artifacts[0]?.type).toBe('interactive');
    expect(page?.notes.map((n) => n.id)).toEqual(['h1']);
  });

  it('resolves parent name', async () => {
    const db = testDb();
    await seedKnowledge('kp', { name: '文言文' });
    await seedKnowledge('kc', { name: '虚词', parent_id: 'kp' });
    const page = await loadKnowledgeNodePage(db, 'kc');
    expect(page?.parent_id).toBe('kp');
    expect(page?.parent_name).toBe('文言文');
  });

  // S10 (YUK-335 audit §3.9): hierarchy block needs direct children with mastery
  // (from the knowledge_mastery view, null when unpracticed), name-ordered, with
  // archived children excluded (same dead-link discipline as the parent lookup).
  it('returns direct children with mastery, name-ordered', async () => {
    const db = testDb();
    await seedKnowledge('kp', { name: '文言文' });
    // ASCII-prefixed names so ORDER BY name is deterministic regardless of the
    // DB collation (Chinese byte-order is collation-dependent).
    await seedKnowledge('kb', { name: 'B 之乎者也', parent_id: 'kp' });
    await seedKnowledge('ka', { name: 'A 介词', parent_id: 'kp' });
    const page = await loadKnowledgeNodePage(db, 'kp');
    expect(page?.children.map((c) => c.id)).toEqual(['ka', 'kb']);
    expect(page?.children.map((c) => c.name)).toEqual(['A 介词', 'B 之乎者也']);
    // mastery field is wired through; null for never-practiced children
    expect(page?.children.every((c) => c.mastery === null)).toBe(true);
  });

  it('returns an empty children array for a leaf node', async () => {
    const db = testDb();
    await seedKnowledge('kp', { name: '文言文' });
    await seedKnowledge('leaf', { name: '虚词', parent_id: 'kp' });
    const page = await loadKnowledgeNodePage(db, 'leaf');
    expect(page?.children).toEqual([]);
  });

  it('excludes archived children from the hierarchy block', async () => {
    const db = testDb();
    await seedKnowledge('kp', { name: '文言文' });
    await seedKnowledge('kc-live', { name: '虚词', parent_id: 'kp' });
    await seedKnowledge('kc-arch', { name: '实词', parent_id: 'kp' });
    await archiveKnowledge('kc-arch');
    const page = await loadKnowledgeNodePage(db, 'kp');
    expect(page?.children.map((c) => c.id)).toEqual(['kc-live']);
  });

  it('returns mesh neighbors from both directions', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedKnowledge('k2', { name: '之' });
    await seedKnowledge('k3', { name: '也' });
    // k1 → k2 (out from k1); k3 → k1 (in to k1)
    await seedEdge('k1', 'k2', 'prerequisite');
    await seedEdge('k3', 'k1', 'related_to');
    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.mesh_neighbors).toHaveLength(2);
    const out = page?.mesh_neighbors.find((n) => n.direction === 'out');
    const inNeighbor = page?.mesh_neighbors.find((n) => n.direction === 'in');
    expect(out?.knowledge_id).toBe('k2');
    expect(out?.relation_type).toBe('prerequisite');
    expect(inNeighbor?.knowledge_id).toBe('k3');
    expect(inNeighbor?.relation_type).toBe('related_to');
  });

  it('surfaces primary atomic when ready and has body_blocks', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    const blocks = { type: 'doc', content: [] };
    await seedAtomicArtifact('a1', 'k1', blocks);
    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.primary_atomic).not.toBeNull();
    expect(page?.primary_atomic?.id).toBe('a1');
    expect(page?.primary_atomic?.generation_status).toBe('ready');
    expect(page?.primary_atomic?.body_blocks).toEqual(blocks);
  });

  it('does not surface archived atomic', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    const now = new Date();
    await testDb()
      .insert(artifact)
      .values({
        id: 'a-archived',
        type: 'note_atomic',
        title: 'archived-atomic',
        knowledge_ids: ['k1'],
        body_blocks: { type: 'doc', content: [] } as never,
        generation_status: 'ready',
        archived_at: now,
        created_at: now,
        updated_at: now,
        ...A_BASE,
      });
    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.primary_atomic).toBeNull();
  });

  it('surfaces timeline entries for events referencing the knowledge id', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedEvent('ev1', 'k1');
    await seedEvent('ev2', 'k1');
    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.timeline).toHaveLength(2);
    expect(page?.timeline[0].action).toBe('attempt');
    expect(page?.timeline[0].actor_kind).toBe('user');
  });

  it('filters out events not referencing the knowledge id', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedKnowledge('k2', { name: '之' });
    await seedEvent('ev1', 'k2'); // different knowledge id
    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.timeline).toHaveLength(0);
  });

  it('reads backlinks for the primary atomic (cross_link refs)', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    // primary atomic for k1
    await seedAtomicArtifact('a-target', 'k1');
    // source artifact that cross-links to a-target (different knowledge_id so it
    // is NOT picked up as the primary atomic for k1 — only a-target qualifies)
    const now = new Date();
    await testDb()
      .insert(artifact)
      .values({
        id: 'a-source',
        type: 'note_hub',
        title: 'source-hub',
        knowledge_ids: ['k1'],
        generation_status: 'ready',
        archived_at: null,
        created_at: now,
        updated_at: now,
        ...A_BASE,
      });
    // insert L2 backlink index row
    await testDb().insert(artifact_block_ref).values({
      from_artifact_id: 'a-source',
      from_block_id: 'blk1',
      to_artifact_id: 'a-target',
      to_block_id: null,
      ref_kind: 'cross_link',
    });
    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.backlinks).toHaveLength(1);
    expect(page?.backlinks[0].from_artifact_id).toBe('a-source');
    expect(page?.backlinks[0].from_block_id).toBe('blk1');
    expect(page?.backlinks_by_type.note_hub).toHaveLength(1);
    expect(page?.backlinks_by_type.note_hub[0].from_artifact_id).toBe('a-source');
  });

  it('groups backlinks by source artifact type for typed panels', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedAtomicArtifact('a-target', 'k1');
    await seedSourceArtifact('src-hub', 'k1', 'note_hub');
    await seedSourceArtifact('src-long', 'k1', 'note_long');
    await seedSourceArtifact('src-quiz', 'k1', 'tool_quiz');
    await seedBacklinkRef('src-hub', 'a-target', 'hub-block');
    await seedBacklinkRef('src-long', 'a-target', 'long-block');
    await seedBacklinkRef('src-quiz', 'a-target', 'quiz-block');

    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(Object.keys(page?.backlinks_by_type ?? {}).sort()).toEqual([
      'note_hub',
      'note_long',
      'tool_quiz',
    ]);
    expect(page?.backlinks_by_type.note_hub.map((b) => b.from_artifact_id)).toEqual(['src-hub']);
    expect(page?.backlinks_by_type.note_long.map((b) => b.from_artifact_id)).toEqual(['src-long']);
    expect(page?.backlinks_by_type.tool_quiz.map((b) => b.from_artifact_id)).toEqual(['src-quiz']);
  });

  it('derives a mastery_decay_bucket from last evidence recency', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    // B1 double-truth fix — evidence_count / last_evidence_at now come from the
    // SoT mastery_state (last_outcome_at), NOT raw event rows. Seed the state the
    // way the attempt path writes it: 3 stale observations.
    const old = new Date(Date.now() - 35 * 86_400_000);
    await upsertMasteryState(db, {
      subject_id: 'k1',
      theta_hat: -0.5,
      evidence_count: 3,
      success_count: 1,
      fail_count: 2,
      last_outcome_at: old,
    });

    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.evidence_count).toBe(3);
    expect(page?.mastery_decay_bucket).toBe('stale');
  });

  // Bug 2 (Codex #193): archived parent must not surface a dead-link parent_name.
  it('returns null parent_name when the parent is archived', async () => {
    const db = testDb();
    await seedArchivedKnowledge('kp', { name: '文言文' });
    await seedKnowledge('kc', { name: '虚词', parent_id: 'kp' });
    const page = await loadKnowledgeNodePage(db, 'kc');
    expect(page?.parent_id).toBe('kp');
    expect(page?.parent_name).toBeNull();
  });

  // Bug 3 (Codex #193): archived mesh neighbors must be dropped (no id-fallback
  // chip), for both out and in directions.
  it('drops archived mesh neighbors in both directions', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedKnowledge('k-live-out', { name: '之' });
    await seedKnowledge('k-arch-out', { name: '其' });
    await seedKnowledge('k-live-in', { name: '也' });
    await seedKnowledge('k-arch-in', { name: '乎' });
    // Seed edges while all neighbors are live (createKnowledgeEdge rejects archived
    // endpoints), then archive two of them — modelling a node archived AFTER the
    // edge was created, which is exactly the dead-link scenario (Codex #193).
    // out edges: k1 → live, k1 → archived (archived must be dropped)
    await seedEdge('k1', 'k-live-out', 'prerequisite');
    await seedEdge('k1', 'k-arch-out', 'related_to');
    // in edges: live → k1, archived → k1 (archived must be dropped)
    await seedEdge('k-live-in', 'k1', 'related_to');
    await seedEdge('k-arch-in', 'k1', 'contrasts_with');
    await archiveKnowledge('k-arch-out');
    await archiveKnowledge('k-arch-in');

    const page = await loadKnowledgeNodePage(db, 'k1');
    const neighborIds = (page?.mesh_neighbors ?? []).map((n) => n.knowledge_id).sort();
    expect(neighborIds).toEqual(['k-live-in', 'k-live-out']);
    // no chip should fall back to rendering an archived neighbor's id as its name
    expect(page?.mesh_neighbors.some((n) => n.knowledge_id === 'k-arch-out')).toBe(false);
    expect(page?.mesh_neighbors.some((n) => n.knowledge_id === 'k-arch-in')).toBe(false);
  });

  // Bug 1 (Codex #193): backlink source artifact resolves to its owning
  // learning_item.id (NOT the artifact id) so the panel links to a route that
  // queries by learning_item.id.
  it('resolves backlink source to its owning learning_item id', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedAtomicArtifact('a-target', 'k1');
    await seedSourceArtifact('a-source', 'k1');
    // owning learning_item whose primary_artifact_id points at the source artifact
    await seedLearningItem('li-source', 'a-source');
    await seedBacklinkRef('a-source', 'a-target', 'blk1');

    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.backlinks).toHaveLength(1);
    expect(page?.backlinks[0].from_artifact_id).toBe('a-source');
    expect(page?.backlinks[0].from_learning_item_id).toBe('li-source');
  });

  // Bug 1 edge (Codex #193): when the source artifact has no non-archived owning
  // learning_item, from_learning_item_id is null so the panel renders a non-link.
  it('returns null from_learning_item_id when no owning learning_item exists', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedAtomicArtifact('a-target', 'k1');
    await seedSourceArtifact('a-orphan', 'k1');
    await seedBacklinkRef('a-orphan', 'a-target', 'blk1');

    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.backlinks).toHaveLength(1);
    expect(page?.backlinks[0].from_artifact_id).toBe('a-orphan');
    expect(page?.backlinks[0].from_learning_item_id).toBeNull();
  });

  it('returns null from_learning_item_id when the owning learning_item is archived', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedAtomicArtifact('a-target', 'k1');
    await seedSourceArtifact('a-source', 'k1');
    await seedLearningItem('li-archived', 'a-source', { archived: true });
    await seedBacklinkRef('a-source', 'a-target', 'blk1');

    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.backlinks).toHaveLength(1);
    expect(page?.backlinks[0].from_artifact_id).toBe('a-source');
    expect(page?.backlinks[0].from_learning_item_id).toBeNull();
  });

  // YUK-161 Bug 1: the primary atomic's title links to its owning learning_item.id
  // (NOT the artifact id), same class as the backlink fix — linking by artifact id
  // 404s. owning_learning_item_id resolves from learning_item.primary_artifact_id.
  it('resolves primary atomic owning_learning_item_id from primary_artifact_id', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedAtomicArtifact('a1', 'k1', { type: 'doc', content: [] });
    // owning learning_item whose primary_artifact_id points at the primary atomic
    await seedLearningItem('li-1', 'a1');

    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.primary_atomic?.id).toBe('a1');
    // the page-link target is the learning_item id, not the artifact id
    expect(page?.primary_atomic?.owning_learning_item_id).toBe('li-1');
    expect(page?.primary_atomic?.owning_learning_item_id).not.toBe('a1');
  });

  // YUK-161 Bug 1 edge: no non-archived owning learning_item → null so the title
  // renders as a non-link (never a 404 href).
  it('returns null primary atomic owning_learning_item_id when no owning learning_item exists', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedAtomicArtifact('a1', 'k1', { type: 'doc', content: [] });

    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.primary_atomic?.id).toBe('a1');
    expect(page?.primary_atomic?.owning_learning_item_id).toBeNull();
  });

  it('returns null primary atomic owning_learning_item_id when the owning learning_item is archived', async () => {
    const db = testDb();
    await seedKnowledge('k1', { name: '虚词' });
    await seedAtomicArtifact('a1', 'k1', { type: 'doc', content: [] });
    await seedLearningItem('li-archived', 'a1', { archived: true });

    const page = await loadKnowledgeNodePage(db, 'k1');
    expect(page?.primary_atomic?.id).toBe('a1');
    expect(page?.primary_atomic?.owning_learning_item_id).toBeNull();
  });

  // YUK-161 Bug 2: resolveEffectiveDomain must stop at an archived ancestor, the
  // same archived-stop semantics loadTreeSnapshot uses (it only keeps non-archived
  // rows in byId). A null-domain child under an archived ancestor that carries a
  // domain must NOT inherit that domain — pre-fix the walk had no archived filter
  // and returned the archived ancestor's domain, diverging from the tree.
  it('does not inherit effective_domain from an archived ancestor', async () => {
    const db = testDb();
    const now = new Date();
    // archived parent carrying a non-null domain
    await db.insert(knowledge).values({
      id: 'kp-archived',
      name: '数学',
      parent_id: null,
      domain: 'math',
      archived_at: now,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      version: 0,
      created_at: now,
      updated_at: now,
    });
    // live child with a null domain → would inherit from the parent chain
    await db.insert(knowledge).values({
      id: 'kc',
      name: '虚词',
      parent_id: 'kp-archived',
      domain: null,
      archived_at: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      version: 0,
      created_at: now,
      updated_at: now,
    });

    const page = await loadKnowledgeNodePage(db, 'kc');
    expect(page).not.toBeNull();
    expect(page?.domain).toBeNull();
    // archived-stop semantics: the archived ancestor's domain must NOT leak through
    expect(page?.effective_domain).not.toBe('math');
    expect(page?.effective_domain).toBeNull();
  });

  // YUK-161 Bug 2 positive control: a NON-archived ancestor's domain is still
  // inherited (the fix only stops at archived rows, not all walks).
  it('still inherits effective_domain from a non-archived ancestor', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'kp-live',
      name: '数学',
      parent_id: null,
      domain: 'math',
      archived_at: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      version: 0,
      created_at: now,
      updated_at: now,
    });
    await db.insert(knowledge).values({
      id: 'kc2',
      name: '虚词',
      parent_id: 'kp-live',
      domain: null,
      archived_at: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      version: 0,
      created_at: now,
      updated_at: now,
    });

    const page = await loadKnowledgeNodePage(db, 'kc2');
    expect(page?.domain).toBeNull();
    expect(page?.effective_domain).toBe('math');
  });
});
