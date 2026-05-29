import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { artifact, event, knowledge } from '@/db/schema';
import { persistHubLinkDismiss } from '@/server/artifacts/hub-dismiss';
import { runHubAutoSyncNightly } from '@/server/boss/handlers/hub_auto_sync_nightly';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { POST } from './route';

const NOW = new Date('2026-05-29T00:00:00.000Z');

// Hub auto-zone doc: one AutoLinksContainer holding a single system auto-link
// (auto:true) pointing at `atomicId`, plus a user-written manual cross_link that
// must survive dismiss.
function hubDoc(atomicId: string) {
  return {
    type: 'doc',
    content: [
      {
        type: 'semanticBlock',
        attrs: { id: 'manual_sec', semantic_kind: 'definition' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '手动区' }] }],
      },
      {
        type: 'autoLinksContainer',
        attrs: { id: 'hub1__auto_links', title: 'Related' },
        content: [
          {
            type: 'crossLinkBlock',
            attrs: {
              id: `hub1__auto_links__${atomicId}`,
              artifact_id: atomicId,
              block_id: null,
              title: '子主题原子',
              auto: true,
              relation: 'subtopic',
            },
          },
        ],
      },
    ],
  };
}

// Hub auto-zone doc holding two system auto-links, for the concurrent /
// sequential multi-target dismiss tests.
function hubDocWithLinks(...atomicIds: string[]) {
  return {
    type: 'doc',
    content: [
      {
        type: 'autoLinksContainer',
        attrs: { id: 'hub1__auto_links', title: 'Related' },
        content: atomicIds.map((atomicId) => ({
          type: 'crossLinkBlock',
          attrs: {
            id: `hub1__auto_links__${atomicId}`,
            artifact_id: atomicId,
            block_id: null,
            title: atomicId,
            auto: true,
            relation: 'subtopic',
          },
        })),
      },
    ],
  };
}

async function seedArtifact(opts: {
  id: string;
  title: string;
  type?: string;
  knowledge_ids?: string[];
  body_blocks?: unknown;
  attrs?: Record<string, unknown>;
}): Promise<void> {
  await testDb()
    .insert(artifact)
    .values({
      id: opts.id,
      type: opts.type ?? 'note_atomic',
      title: opts.title,
      parent_artifact_id: null,
      knowledge_ids: opts.knowledge_ids ?? [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: (opts.body_blocks ?? { type: 'doc', content: [] }) as never,
      attrs: (opts.attrs ?? {}) as never,
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'verified',
      verification_summary: null,
      generated_by: null,
      verified_by: null,
      embedded_check_status: 'not_required',
      history: [],
      archived_at: null,
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });
}

async function seedKnowledge(id: string, parentId: string | null): Promise<void> {
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: id,
      domain: parentId ? null : 'wenyan',
      parent_id: parentId,
      created_at: NOW,
      updated_at: NOW,
    } as never);
}

function dismissReq(hubId: string, body: unknown): Request {
  return new Request(`http://localhost/api/hubs/${hubId}/dismiss-link`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function loadHub(hubId: string) {
  const [row] = await testDb()
    .select({ attrs: artifact.attrs, body_blocks: artifact.body_blocks })
    .from(artifact)
    .where(eq(artifact.id, hubId));
  return row;
}

function autoLinkArtifactIds(bodyBlocks: unknown): string[] {
  const doc = (bodyBlocks ?? {}) as { content?: Array<Record<string, unknown>> };
  const container = (doc.content ?? []).find((n) => n.type === 'autoLinksContainer');
  const children = (container?.content as Array<Record<string, unknown>> | undefined) ?? [];
  return children
    .map((c) => (c.attrs as Record<string, unknown> | undefined)?.artifact_id)
    .filter((id): id is string => typeof id === 'string');
}

describe('POST /api/hubs/[id]/dismiss-link', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('appends suppressed_block_refs, writes a suppress event, and removes the child', async () => {
    await seedArtifact({ id: 'atomic1', title: '子主题原子', knowledge_ids: ['k_child'] });
    await seedArtifact({
      id: 'hub1',
      title: 'Hub',
      type: 'note_hub',
      knowledge_ids: ['k_hub'],
      body_blocks: hubDoc('atomic1'),
    });

    const res = await POST(dismissReq('hub1', { suppressed_artifact_id: 'atomic1' }), {
      params: Promise.resolve({ id: 'hub1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean; suppress_event_id: string };
    expect(body.removed).toBe(true);

    const hub = await loadHub('hub1');
    // suppressed_block_refs recorded with the dismissed target.
    expect((hub.attrs as Record<string, unknown>).suppressed_block_refs).toEqual([
      { artifact_id: 'atomic1' },
    ]);
    // Child removed from the container immediately.
    expect(autoLinkArtifactIds(hub.body_blocks)).toEqual([]);

    // suppress event written (subject = hub).
    const suppressRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'suppress'), eq(event.subject_id, 'hub1')));
    expect(suppressRows).toHaveLength(1);
    expect((suppressRows[0].payload as Record<string, unknown>).suppressed_artifact_id).toBe(
      'atomic1',
    );
  });

  it('is idempotent — dismissing twice leaves a single suppressed_block_refs entry', async () => {
    await seedArtifact({ id: 'atomic1', title: '子主题原子', knowledge_ids: ['k_child'] });
    await seedArtifact({
      id: 'hub1',
      title: 'Hub',
      type: 'note_hub',
      knowledge_ids: ['k_hub'],
      body_blocks: hubDoc('atomic1'),
    });

    await POST(dismissReq('hub1', { suppressed_artifact_id: 'atomic1' }), {
      params: Promise.resolve({ id: 'hub1' }),
    });
    const res2 = await POST(dismissReq('hub1', { suppressed_artifact_id: 'atomic1' }), {
      params: Promise.resolve({ id: 'hub1' }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { removed: boolean };
    // Second dismiss: child already gone → no second body_blocks mutation.
    expect(body2.removed).toBe(false);

    const hub = await loadHub('hub1');
    expect((hub.attrs as Record<string, unknown>).suppressed_block_refs).toEqual([
      { artifact_id: 'atomic1' },
    ]);
  });

  it('next hub_auto_sync run skips the suppressed atomic (honors suppressed_block_refs)', async () => {
    // Tree: hub knowledge node is the parent of the atomic's node → subtopic.
    await seedKnowledge('k_hub', null);
    await seedKnowledge('k_child', 'k_hub');
    await seedArtifact({ id: 'atomic1', title: '子主题原子', knowledge_ids: ['k_child'] });
    await seedArtifact({
      id: 'hub1',
      title: 'Hub',
      type: 'note_hub',
      knowledge_ids: ['k_hub'],
      body_blocks: hubDoc('atomic1'),
    });

    // Dismiss it.
    await POST(dismissReq('hub1', { suppressed_artifact_id: 'atomic1' }), {
      params: Promise.resolve({ id: 'hub1' }),
    });

    // Sanity: removed from the container.
    expect(autoLinkArtifactIds((await loadHub('hub1')).body_blocks)).toEqual([]);

    // Run the nightly sync — it must NOT re-add the suppressed atomic.
    const result = await runHubAutoSyncNightly(testDb(), { now: NOW });
    expect(result.cross_links_desired_total).toBe(0);
    expect(autoLinkArtifactIds((await loadHub('hub1')).body_blocks)).toEqual([]);
  });

  it('rejects dismiss on a non-hub artifact', async () => {
    await seedArtifact({ id: 'atomic1', title: '原子' });
    const res = await POST(dismissReq('atomic1', { suppressed_artifact_id: 'x' }), {
      params: Promise.resolve({ id: 'atomic1' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown hub', async () => {
    const res = await POST(dismissReq('missing', { suppressed_artifact_id: 'x' }), {
      params: Promise.resolve({ id: 'missing' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a missing suppressed_artifact_id', async () => {
    await seedArtifact({ id: 'hub1', title: 'Hub', type: 'note_hub', body_blocks: hubDoc('a') });
    const res = await POST(dismissReq('hub1', {}), {
      params: Promise.resolve({ id: 'hub1' }),
    });
    expect(res.status).toBe(400);
  });

  // YUK-155 review-2: FOR UPDATE row lock on the hub select serializes concurrent
  // dismisses of DIFFERENT auto-links on the SAME hub. Without the lock the two
  // transactions read the same attrs snapshot, each JS-appends one ref, and the
  // later commit overwrites the earlier → one suppressed entry is lost. We run two
  // dismiss transactions concurrently (each on its own pooled connection) and
  // assert BOTH suppressed entries survive. The lock makes the second tx block
  // until the first commits, so it reads the already-updated attrs before append.
  it('concurrent dismiss of two targets keeps BOTH suppressed_block_refs (no lost update)', async () => {
    await seedArtifact({ id: 'atomic1', title: '原子一', knowledge_ids: ['k1'] });
    await seedArtifact({ id: 'atomic2', title: '原子二', knowledge_ids: ['k2'] });
    await seedArtifact({
      id: 'hub1',
      title: 'Hub',
      type: 'note_hub',
      knowledge_ids: ['k_hub'],
      body_blocks: hubDocWithLinks('atomic1', 'atomic2'),
    });

    // Two independent transactions, kicked off together. The pool (max:10) gives
    // each its own connection so they genuinely contend for the hub row lock.
    await Promise.all([
      db.transaction((tx) =>
        persistHubLinkDismiss(tx, { hubId: 'hub1', suppressedArtifactId: 'atomic1' }),
      ),
      db.transaction((tx) =>
        persistHubLinkDismiss(tx, { hubId: 'hub1', suppressedArtifactId: 'atomic2' }),
      ),
    ]);

    const hub = await loadHub('hub1');
    const suppressed = ((hub.attrs as Record<string, unknown>).suppressed_block_refs ??
      []) as Array<{ artifact_id: string }>;
    const ids = suppressed.map((s) => s.artifact_id).sort();
    expect(ids).toEqual(['atomic1', 'atomic2']);
    // Both auto-links removed from the container too (each tx removed its own).
    expect(autoLinkArtifactIds(hub.body_blocks)).toEqual([]);

    // Two distinct suppress events recorded (append-only history, one per dismiss).
    const suppressRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'suppress'), eq(event.subject_id, 'hub1')));
    expect(suppressRows).toHaveLength(2);
  });

  it('sequential dismiss of two targets accumulates both suppressed entries', async () => {
    await seedArtifact({ id: 'atomic1', title: '原子一', knowledge_ids: ['k1'] });
    await seedArtifact({ id: 'atomic2', title: '原子二', knowledge_ids: ['k2'] });
    await seedArtifact({
      id: 'hub1',
      title: 'Hub',
      type: 'note_hub',
      knowledge_ids: ['k_hub'],
      body_blocks: hubDocWithLinks('atomic1', 'atomic2'),
    });

    await POST(dismissReq('hub1', { suppressed_artifact_id: 'atomic1' }), {
      params: Promise.resolve({ id: 'hub1' }),
    });
    await POST(dismissReq('hub1', { suppressed_artifact_id: 'atomic2' }), {
      params: Promise.resolve({ id: 'hub1' }),
    });

    const hub = await loadHub('hub1');
    const ids = (
      ((hub.attrs as Record<string, unknown>).suppressed_block_refs ?? []) as Array<{
        artifact_id: string;
      }>
    )
      .map((s) => s.artifact_id)
      .sort();
    expect(ids).toEqual(['atomic1', 'atomic2']);
    expect(autoLinkArtifactIds(hub.body_blocks)).toEqual([]);
  });
});
