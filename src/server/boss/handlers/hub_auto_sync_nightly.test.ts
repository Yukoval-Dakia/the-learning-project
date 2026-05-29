// YUK-95 P5 Lane-C — DB partition test for the nightly hub auto-sync worker.
// Real Postgres (testcontainer): seeds a hub + atomic, runs the worker, asserts
// the AutoLinksContainer cross_link lands with the right relation attr, the L2
// artifact_block_ref row appears (Lane-0 sync), suppressed atomics are skipped,
// and a second unchanged run writes no new event (idempotent).

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { artifact, artifact_block_ref, event, knowledge, knowledge_edge } from '@/db/schema';
import { buildHubAutoSyncNightlyHandler, runHubAutoSyncNightly } from './hub_auto_sync_nightly';

import { resetDb, testDb } from '../../../../tests/helpers/db';

const NOW = new Date('2026-05-29T18:45:00Z');

async function seedKnowledge(id: string, opts: { parentId?: string | null; domain?: string } = {}) {
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: id,
      domain: opts.parentId ? null : (opts.domain ?? 'wenyan'),
      parent_id: opts.parentId ?? null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });
}

async function seedArtifact(opts: {
  id: string;
  type: 'note_hub' | 'note_atomic';
  knowledgeIds: string[];
  bodyBlocks?: unknown;
  attrs?: Record<string, unknown>;
  title?: string;
}) {
  await testDb()
    .insert(artifact)
    .values({
      id: opts.id,
      type: opts.type,
      title: opts.title ?? opts.id,
      parent_artifact_id: null,
      knowledge_ids: opts.knowledgeIds,
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: (opts.bodyBlocks ?? { type: 'doc', content: [] }) as never,
      attrs: (opts.attrs ?? {}) as never,
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'verified',
      verification_summary: null,
      generated_by: null,
      verified_by: null,
      history: [],
      archived_at: null,
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });
}

async function seedEdge(from: string, to: string, relation: string) {
  await testDb()
    .insert(knowledge_edge)
    .values({
      id: `${from}_${relation}_${to}`,
      from_knowledge_id: from,
      to_knowledge_id: to,
      relation_type: relation,
      weight: 1,
      created_by: 'user' as never,
      reasoning: null,
      created_at: NOW,
    });
}

function autoZoneChildren(bodyBlocks: unknown): Array<Record<string, unknown>> {
  const content = (bodyBlocks as { content?: unknown[] })?.content ?? [];
  const container = content.find(
    (n): n is Record<string, unknown> =>
      n !== null &&
      typeof n === 'object' &&
      (n as { type?: unknown }).type === 'autoLinksContainer',
  );
  const children = container && Array.isArray(container.content) ? container.content : [];
  return children.filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object');
}

describe('runHubAutoSyncNightly', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('no-op with 0 hubs', async () => {
    const result = await runHubAutoSyncNightly(testDb(), { now: NOW });
    expect(result).toMatchObject({ hubs_considered: 0, hubs_updated: 0 });
  });

  it('same-topic atomic → AutoLinksContainer gets a subtopic cross_link + block-ref row', async () => {
    await seedKnowledge('k_hub');
    await seedArtifact({ id: 'hub1', type: 'note_hub', knowledgeIds: ['k_hub'] });
    await seedArtifact({
      id: 'atom1',
      type: 'note_atomic',
      knowledgeIds: ['k_hub'],
      title: '之的助词用法',
    });

    const result = await runHubAutoSyncNightly(testDb(), { now: NOW });
    expect(result.hubs_updated).toBe(1);
    expect(result.cross_links_desired_total).toBe(1);

    const [hub] = await testDb().select().from(artifact).where(eq(artifact.id, 'hub1'));
    expect(hub.version).toBe(1);
    const children = autoZoneChildren(hub.body_blocks);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      type: 'crossLinkBlock',
      attrs: {
        artifact_id: 'atom1',
        title: '之的助词用法',
        auto: true,
        relation: 'subtopic',
      },
    });

    // Lane-0 write-through: the L2 cross_link index row exists.
    const refs = await testDb()
      .select()
      .from(artifact_block_ref)
      .where(eq(artifact_block_ref.from_artifact_id, 'hub1'));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      to_artifact_id: 'atom1',
      ref_kind: 'cross_link',
    });

    // Exactly one apply event written.
    const events = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:note_refine_apply'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ subject_id: 'hub1', actor_ref: 'hub_auto_sync' });
  });

  it('tags prerequisite/derived_from/contrasts_with relations from mesh edges', async () => {
    await seedKnowledge('k_hub');
    await seedKnowledge('k_prereq');
    await seedKnowledge('k_variant');
    await seedKnowledge('k_contrast');
    await seedEdge('k_prereq', 'k_hub', 'prerequisite');
    await seedEdge('k_variant', 'k_hub', 'derived_from');
    await seedEdge('k_contrast', 'k_hub', 'contrasts_with');
    // excluded relations must NOT pull atomics in
    await seedKnowledge('k_rel');
    await seedEdge('k_rel', 'k_hub', 'related_to');

    await seedArtifact({ id: 'hub1', type: 'note_hub', knowledgeIds: ['k_hub'] });
    await seedArtifact({
      id: 'a_pre',
      type: 'note_atomic',
      knowledgeIds: ['k_prereq'],
      title: 'P',
    });
    await seedArtifact({
      id: 'a_var',
      type: 'note_atomic',
      knowledgeIds: ['k_variant'],
      title: 'V',
    });
    await seedArtifact({
      id: 'a_con',
      type: 'note_atomic',
      knowledgeIds: ['k_contrast'],
      title: 'C',
    });
    await seedArtifact({ id: 'a_rel', type: 'note_atomic', knowledgeIds: ['k_rel'], title: 'R' });

    await runHubAutoSyncNightly(testDb(), { now: NOW });

    const [hub] = await testDb().select().from(artifact).where(eq(artifact.id, 'hub1'));
    const byArtifact = new Map(
      autoZoneChildren(hub.body_blocks).map((c) => {
        const attrs = c.attrs as Record<string, unknown>;
        return [attrs.artifact_id as string, attrs.relation as string];
      }),
    );
    expect(byArtifact.get('a_pre')).toBe('prerequisite');
    expect(byArtifact.get('a_var')).toBe('derived_from');
    expect(byArtifact.get('a_con')).toBe('contrasts_with');
    expect(byArtifact.has('a_rel')).toBe(false);
  });

  it('skips a suppressed atomic (suppressed_block_refs)', async () => {
    await seedKnowledge('k_hub');
    await seedArtifact({
      id: 'hub1',
      type: 'note_hub',
      knowledgeIds: ['k_hub'],
      attrs: { suppressed_block_refs: [{ artifact_id: 'atom_keep_out' }] },
    });
    await seedArtifact({
      id: 'atom_in',
      type: 'note_atomic',
      knowledgeIds: ['k_hub'],
      title: 'In',
    });
    await seedArtifact({
      id: 'atom_keep_out',
      type: 'note_atomic',
      knowledgeIds: ['k_hub'],
      title: 'Out',
    });

    await runHubAutoSyncNightly(testDb(), { now: NOW });

    const [hub] = await testDb().select().from(artifact).where(eq(artifact.id, 'hub1'));
    const ids = autoZoneChildren(hub.body_blocks).map(
      (c) => (c.attrs as Record<string, unknown>).artifact_id,
    );
    expect(ids).toEqual(['atom_in']);
  });

  it('one bad hub is tallied (hubs_failed) and does not abort the batch (FIX 4)', async () => {
    await seedKnowledge('k_hub');
    // Bad hub: its existing autoLinksContainer has a NULL id at doc root, so
    // buildAutoZonePatch derives a fallback container id (`bad_hub__auto_links`)
    // that matches no doc-root block → applyNotePatch throws target_not_found.
    await seedArtifact({
      id: 'bad_hub',
      type: 'note_hub',
      knowledgeIds: ['k_hub'],
      bodyBlocks: {
        type: 'doc',
        content: [{ type: 'autoLinksContainer', attrs: { id: null }, content: [] }],
      },
    });
    // Healthy hub: clean empty doc, gets its auto-zone appended normally.
    await seedArtifact({ id: 'good_hub', type: 'note_hub', knowledgeIds: ['k_hub'] });
    await seedArtifact({ id: 'atom1', type: 'note_atomic', knowledgeIds: ['k_hub'], title: 'A' });

    const result = await runHubAutoSyncNightly(testDb(), { now: NOW });

    // Batch survived the bad hub.
    expect(result.hubs_considered).toBe(2);
    expect(result.hubs_failed).toBe(1);
    expect(result.hubs_updated).toBe(1);

    // The healthy hub still got its auto-zone.
    const [good] = await testDb().select().from(artifact).where(eq(artifact.id, 'good_hub'));
    expect(autoZoneChildren(good.body_blocks)).toHaveLength(1);

    // The bad hub was left untouched (version unchanged, no partial write).
    const [bad] = await testDb().select().from(artifact).where(eq(artifact.id, 'bad_hub'));
    expect(bad.version).toBe(0);
  });

  it('idempotent: a second run with no mesh change writes no new event', async () => {
    await seedKnowledge('k_hub');
    await seedArtifact({ id: 'hub1', type: 'note_hub', knowledgeIds: ['k_hub'] });
    await seedArtifact({ id: 'atom1', type: 'note_atomic', knowledgeIds: ['k_hub'], title: 'A' });

    const first = await runHubAutoSyncNightly(testDb(), { now: NOW });
    expect(first.hubs_updated).toBe(1);

    const second = await runHubAutoSyncNightly(testDb(), { now: NOW });
    expect(second.hubs_updated).toBe(0);

    const [hub] = await testDb().select().from(artifact).where(eq(artifact.id, 'hub1'));
    expect(hub.version).toBe(1); // unchanged after the no-op second run

    const events = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:note_refine_apply'));
    expect(events).toHaveLength(1); // no second event

    // Block-ref index still has exactly one row (no churn).
    const refs = await testDb()
      .select()
      .from(artifact_block_ref)
      .where(
        and(
          eq(artifact_block_ref.from_artifact_id, 'hub1'),
          eq(artifact_block_ref.ref_kind, 'cross_link'),
        ),
      );
    expect(refs).toHaveLength(1);
  });
});

describe('buildHubAutoSyncNightlyHandler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('runs for each job and applies the auto-zone patch', async () => {
    await seedKnowledge('k_hub');
    await seedArtifact({ id: 'hub1', type: 'note_hub', knowledgeIds: ['k_hub'] });
    await seedArtifact({ id: 'atom1', type: 'note_atomic', knowledgeIds: ['k_hub'], title: 'A' });

    const handler = buildHubAutoSyncNightlyHandler(testDb());
    await handler([{ id: 'j1', data: {} } as never]);

    const events = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:note_refine_apply'));
    expect(events).toHaveLength(1);
  });
});
