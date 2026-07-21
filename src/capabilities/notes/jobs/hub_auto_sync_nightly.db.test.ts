// YUK-95 P5 Lane-C — DB partition test for the nightly hub auto-sync worker.
// Real Postgres (testcontainer): seeds a hub + atomic, runs the worker, asserts
// the AutoLinksContainer cross_link lands with the right relation attr, the L2
// artifact_block_ref row appears (Lane-0 sync), suppressed atomics are skipped,
// and a second unchanged run writes no new event (idempotent).

import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { artifact, artifact_block_ref, event, knowledge } from '@/db/schema';

// YUK-384 — the manifest-registered handlers dispatch their continuation via the
// running boss. Peek getRunningBoss so we control it; default unset (no-op).
const bossMock = vi.hoisted(() => ({ getRunningBoss: vi.fn(), send: vi.fn() }));
vi.mock('@/server/boss/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/boss/client')>();
  return { ...actual, getRunningBoss: () => bossMock.getRunningBoss() };
});

import {
  buildHubAutoSyncNightlyHandler,
  buildHubSyncMutationWakeJobHandler,
  buildHubSyncRecoveryJobHandler,
  runHubAutoSyncNightly,
} from './hub_auto_sync_nightly';

import { resetDb, testDb } from '../../../../tests/helpers/db';

const NOW = new Date('2026-05-29T18:45:00Z');

async function seedKnowledge(id: string, opts: { parentId?: string | null; domain?: string } = {}) {
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: id,
      domain: opts.parentId ? null : (opts.domain ?? 'yuwen'),
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

// YUK-384 — the nightly job is now a COVERAGE REPAIR sweep that routes through
// runHubSyncCycle (nightly_repair): it dirties/cancels cursors and the SAME cycle
// then converges them under the fenced reconciler. So `runHubAutoSyncNightly`
// still lands the auto-zone end-to-end (repair + apply), never a direct write.
const APPLY_ACTION = 'experimental:hub_sync_apply';

async function hubBody(id: string) {
  const [row] = await testDb().select().from(artifact).where(eq(artifact.id, id));
  return row.body_blocks;
}

async function applyEventCount(id: string): Promise<number> {
  const rows = await testDb()
    .select()
    .from(event)
    .where(and(eq(event.action, APPLY_ACTION), eq(event.subject_id, id)));
  return rows.length;
}

describe('runHubAutoSyncNightly — repair sweep + reconcile (YUK-384)', () => {
  beforeEach(async () => {
    await resetDb();
    process.env.HUB_SYNC_MODE = 'apply';
  });

  afterEach(() => {
    process.env.HUB_SYNC_MODE = 'off';
  });

  it('no-op with 0 hubs', async () => {
    const result = await runHubAutoSyncNightly(testDb(), { now: NOW });
    expect(result).toMatchObject({ reason: 'nightly_repair', claimed: 0, applied: 0 });
  });

  it('YUK-384 (R2b): sweeps abandoned editor sessions even when HUB_SYNC_MODE=off', async () => {
    // off is NOT a kill switch for presence hygiene — the sweep runs before the mode gate,
    // so zombie rows are reaped even in the disabled/rolled-back state.
    process.env.HUB_SYNC_MODE = 'off';
    await seedKnowledge('kc');
    await seedArtifact({ id: 'hub-a', type: 'note_hub', knowledgeIds: ['kc'] });
    await testDb().execute(sql`
      insert into artifact_edit_session (artifact_id, session_id, started_at, last_heartbeat_at)
      values
        ('hub-a', 'abandoned', clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours'),
        ('hub-a', 'fresh', clock_timestamp(), clock_timestamp())
    `);

    const result = await runHubAutoSyncNightly(testDb(), { now: NOW });

    // off → the reconciler cycle short-circuited, but the sweep still ran.
    expect(result.mode).toBe('off');
    const rows = await testDb().execute<{ session_id: string }>(
      sql`select session_id from artifact_edit_session where artifact_id = 'hub-a' order by session_id`,
    );
    expect(rows.map((r) => r.session_id)).toEqual(['fresh']);
  });

  it('same-topic atomic → AutoLinksContainer subtopic cross_link + L2 block-ref row', async () => {
    await seedKnowledge('k_hub');
    await seedArtifact({
      id: 'atom1',
      type: 'note_atomic',
      knowledgeIds: ['k_hub'],
      title: '之的助词用法',
    });
    await seedArtifact({ id: 'hub1', type: 'note_hub', knowledgeIds: ['k_hub'] });

    const result = await runHubAutoSyncNightly(testDb(), { now: NOW });
    expect(result.applied).toBe(1);

    const children = autoZoneChildren(await hubBody('hub1'));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      type: 'crossLinkBlock',
      attrs: { artifact_id: 'atom1', title: '之的助词用法', auto: true, relation: 'subtopic' },
    });

    // L2 backlink index kept in sync inside the fenced apply.
    const refs = await testDb()
      .select()
      .from(artifact_block_ref)
      .where(eq(artifact_block_ref.from_artifact_id, 'hub1'));
    expect(refs.some((r) => r.to_artifact_id === 'atom1')).toBe(true);
  });

  it('skips a suppressed atomic (attrs.suppressed_block_refs)', async () => {
    await seedKnowledge('k_hub');
    await seedArtifact({
      id: 'atom1',
      type: 'note_atomic',
      knowledgeIds: ['k_hub'],
      title: '被压制',
    });
    await seedArtifact({
      id: 'hub1',
      type: 'note_hub',
      knowledgeIds: ['k_hub'],
      attrs: { suppressed_block_refs: [{ artifact_id: 'atom1' }] },
    });

    await runHubAutoSyncNightly(testDb(), { now: NOW });
    expect(autoZoneChildren(await hubBody('hub1'))).toHaveLength(0);
  });

  it('idempotent: a second run with the same BJT date writes no new apply event', async () => {
    await seedKnowledge('k_hub');
    await seedArtifact({ id: 'atom1', type: 'note_atomic', knowledgeIds: ['k_hub'], title: 'x' });
    await seedArtifact({ id: 'hub1', type: 'note_hub', knowledgeIds: ['k_hub'] });

    await runHubAutoSyncNightly(testDb(), { now: NOW });
    const afterFirst = await applyEventCount('hub1');
    expect(afterFirst).toBe(1);

    await runHubAutoSyncNightly(testDb(), { now: NOW });
    expect(await applyEventCount('hub1')).toBe(afterFirst);
  });
});

describe('buildHubAutoSyncNightlyHandler', () => {
  beforeEach(async () => {
    await resetDb();
    process.env.HUB_SYNC_MODE = 'apply';
  });

  afterEach(() => {
    process.env.HUB_SYNC_MODE = 'off';
  });

  it('runs the repair-sweep cycle for each delivered job without throwing', async () => {
    await seedKnowledge('k_hub');
    await seedArtifact({ id: 'atom1', type: 'note_atomic', knowledgeIds: ['k_hub'], title: 'y' });
    await seedArtifact({ id: 'hub1', type: 'note_hub', knowledgeIds: ['k_hub'] });

    const handler = buildHubAutoSyncNightlyHandler(testDb());
    await handler([{ id: 'job-1' }] as never);
    expect(autoZoneChildren(await hubBody('hub1'))).toHaveLength(1);
  });
});

describe('YUK-384 production continuation dispatch (buildHubSyncRecoveryJobHandler)', () => {
  beforeEach(async () => {
    await resetDb();
    process.env.HUB_SYNC_MODE = 'apply';
    bossMock.getRunningBoss.mockReset();
    bossMock.send.mockReset().mockResolvedValue('job-id');
  });

  afterEach(() => {
    process.env.HUB_SYNC_MODE = 'off';
  });

  it('dispatches exactly ONE singleton-keyed continuation when the backlog exceeds one cycle', async () => {
    bossMock.getRunningBoss.mockReturnValue({ send: bossMock.send });
    await seedKnowledge('kc');
    await seedArtifact({
      id: 'atomic-shared',
      type: 'note_atomic',
      knowledgeIds: ['kc'],
      title: 's',
    });
    for (let i = 0; i < 30; i += 1) {
      await seedArtifact({
        id: `hub-${String(i).padStart(3, '0')}`,
        type: 'note_hub',
        knowledgeIds: ['kc'],
      });
    }

    const handler = buildHubSyncRecoveryJobHandler(testDb());
    await handler([{ id: 'job-1' }] as never);

    expect(bossMock.send).toHaveBeenCalledTimes(1);
    expect(bossMock.send).toHaveBeenCalledWith(
      'hub_sync_recovery',
      {},
      {
        singletonKey: 'hub_sync_recovery_continuation',
        singletonSeconds: 30,
      },
    );
  });

  it('does NOT dispatch a continuation when boss is not running (no-op)', async () => {
    bossMock.getRunningBoss.mockReturnValue(null);
    await seedKnowledge('kc');
    await seedArtifact({
      id: 'atomic-shared',
      type: 'note_atomic',
      knowledgeIds: ['kc'],
      title: 's',
    });
    for (let i = 0; i < 30; i += 1) {
      await seedArtifact({
        id: `hub-${String(i).padStart(3, '0')}`,
        type: 'note_hub',
        knowledgeIds: ['kc'],
      });
    }

    await buildHubSyncRecoveryJobHandler(testDb())([{ id: 'job-1' }] as never);
    expect(bossMock.send).not.toHaveBeenCalled();
  });

  it('the mutation-wake queue consumer actually drives a cycle (converges a ready hub)', async () => {
    bossMock.getRunningBoss.mockReturnValue(null);
    await seedKnowledge('kc');
    await seedArtifact({
      id: 'atomic-shared',
      type: 'note_atomic',
      knowledgeIds: ['kc'],
      title: 's',
    });
    await seedArtifact({ id: 'hub1', type: 'note_hub', knowledgeIds: ['kc'] });

    // A produced wake job runs runHubSyncCycle({reason:'mutation_wake'}) → applies.
    await buildHubSyncMutationWakeJobHandler(testDb())([{ id: 'wake-1' }] as never);

    const rows = await testDb().execute<{ status: string }>(
      sql`select status from hub_sync_reconciliation where artifact_id = 'hub1'`,
    );
    expect(rows[0]?.status).toBe('acknowledged');
  });
});
