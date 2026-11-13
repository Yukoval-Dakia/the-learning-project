/**
 * Match-or-propose must not mint a near-duplicate knowledge point.
 *
 * DB-backed through the kernel `tagKnowledge` entry; the embedder and namer are the
 * only injected seams (external providers), so no model runs.
 *
 * @invariant concurrency: a freshly proposed KC is embedded immediately and a later
 *   question reuses it instead of minting a near-duplicate; normalized-name reuse is
 *   the fallback when the cosine gate misses.
 * @fails-if two questions produce two sibling KCs for one concept.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EMBED_VERSION, embedHash, knowledgeEmbedText } from '@/core/embed-source';
import { knowledge } from '@/db/schema';
import { tagKnowledge } from '@/kernel/records/knowledge-tag';
import { resetDb, testDb } from '../../../tests/helpers/db';

const DIMS = 1024;

function unitVec(i: number): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[i] = 1;
  return v;
}

async function seedSubjectRoot(db: ReturnType<typeof testDb>): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id: 'seed:physics:root',
    name: '物理',
    domain: 'physics',
    parent_id: null,
    role: 'container',
    approval_status: 'approved',
    merged_from: [],
    proposed_by_ai: false,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

beforeEach(async () => {
  await resetDb();
});

describe('tagKnowledge duplicate prevention', () => {
  // @invariant concurrency: a newly proposed KC is matchable immediately, so a sibling question reuses it instead of minting a near-duplicate
  // @fails-if the freshly created node has no embedding or the second question creates a second sibling KC
  it('embeds a proposed KC immediately so the next question matches it', async () => {
    const db = testDb();
    await seedSubjectRoot(db);
    const seenVectors: number[][] = [];
    const embedder = {
      provider: 'stub',
      model: 'stub-embed',
      embed: async () => {
        const v = unitVec(0);
        seenVectors.push(v);
        return v;
      },
    };
    const nameKcFn = vi.fn(async () => ({ kc_name: '楞次定律' }));

    const first = await tagKnowledge(
      { db, embedder, nameKcFn },
      {
        questionText: '闭合回路中磁通量增大时，感应电流的磁场方向如何？',
        subjectRootId: 'seed:physics:root',
      },
    );
    expect(first.kind).toBe('propose');
    const [created] = await db
      .select()
      .from(knowledge)
      .where(and(eq(knowledge.parent_id, 'seed:physics:root'), isNull(knowledge.archived_at)));
    expect(created?.embedding).not.toBeNull();
    expect(created?.embed_version).toBe(EMBED_VERSION);
    const expectedHash = embedHash(
      knowledgeEmbedText({ name: '楞次定律', effectiveDomain: 'physics' }),
    );
    expect(created?.embed_content_hash).toBe(expectedHash);

    const second = await tagKnowledge(
      { db, embedder, nameKcFn },
      {
        questionText: '根据楞次定律，判断线圈中感应电流的方向。',
        subjectRootId: 'seed:physics:root',
      },
    );
    expect(second.kind).toBe('match');
    expect(second.knowledge_ids).toEqual([created?.id]);
    // One concept, one node — no near-duplicate sibling.
    const leaves = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(eq(knowledge.parent_id, 'seed:physics:root'), isNull(knowledge.archived_at)));
    expect(leaves).toHaveLength(1);
    expect(seenVectors.length).toBeGreaterThanOrEqual(3); // question, KC stamp, question
  });

  // @invariant concurrency: normalized-name reuse prevents a punctuation-only re-proposal from minting a duplicate sibling
  // @fails-if the second attribution creates a second KC under the subject root
  it('reuses a same-named KC when the cosine gate misses', async () => {
    const db = testDb();
    await seedSubjectRoot(db);
    let vector = unitVec(0);
    const embedder = {
      provider: 'stub',
      model: 'stub-embed',
      embed: async () => vector,
    };
    const nameKcFn = vi.fn(async () => ({ kc_name: '楞次定律' }));

    const first = await tagKnowledge(
      { db, embedder, nameKcFn },
      { questionText: '第一道题', subjectRootId: 'seed:physics:root' },
    );
    expect(first.kind).toBe('propose');
    const firstId = first.knowledge_ids[0];

    // Force the cosine gate to miss, then propose the same name with punctuation drift.
    vector = unitVec(1);
    const second = await tagKnowledge(
      { db, embedder, nameKcFn: async () => ({ kc_name: ' 楞次定律。' }) },
      { questionText: '第二道题', subjectRootId: 'seed:physics:root' },
    );
    expect(second.knowledge_ids).toEqual([firstId]);
    const leaves = await db
      .select({ id: knowledge.id })
      .from(knowledge)
      .where(and(eq(knowledge.parent_id, 'seed:physics:root'), isNull(knowledge.archived_at)));
    expect(leaves).toHaveLength(1);
  });
});
