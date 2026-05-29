// YUK-96 P6/C — loadKnowledgeNodePage aggregator unit-level DB test.
//
// Verifies the server-side aggregate for the /knowledge/[id] node page:
// single-node metadata, mastery join, mesh neighbors, primary atomic,
// backlinks read-time filter (XC-5), timeline, and not-found path.

import { artifact, artifact_block_ref, event, knowledge } from '@/db/schema';
import { createKnowledgeEdge } from '@/server/knowledge/edges';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
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
  embedded_check_status: 'not_required',
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
    created_by: 'user',
  });
}

async function seedEvent(id: string, knowledgeId: string) {
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
    created_at: new Date(),
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
    expect(page?.mesh_neighbors).toHaveLength(0);
    expect(page?.backlinks).toHaveLength(0);
    expect(page?.timeline).toHaveLength(0);
  });

  it('resolves parent name', async () => {
    const db = testDb();
    await seedKnowledge('kp', { name: '文言文' });
    await seedKnowledge('kc', { name: '虚词', parent_id: 'kp' });
    const page = await loadKnowledgeNodePage(db, 'kc');
    expect(page?.parent_id).toBe('kp');
    expect(page?.parent_name).toBe('文言文');
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
  });
});
