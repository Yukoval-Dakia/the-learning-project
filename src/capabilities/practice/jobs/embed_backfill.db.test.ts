import { db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';

const embedMany = vi.fn(async (texts: string[]) => texts.map(() => Array(1024).fill(0.02)));
vi.mock('@/server/ai/embed', () => ({
  embedMany: (texts: string[]) => embedMany(texts),
  EMBED_MODEL: 'text-embedding-v4',
  EMBED_DIMS: 1024,
}));

describe('embed_backfill', () => {
  beforeEach(async () => {
    await resetDb();
    embedMany.mockClear();
  });

  it('embeds question rows with NULL embedding and stamps model/version/hash', async () => {
    await db.insert(question).values({
      id: 'q1',
      kind: 'single_choice',
      prompt_md: 'P',
      source: 'authentic',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const { runEmbedBackfill } = await import('./embed_backfill');
    const n = await runEmbedBackfill(db, 50);
    expect(n).toBe(1);
    const [row] = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(row.embedding).toHaveLength(1024);
    expect(row.embed_model).toBe('text-embedding-v4');
    expect(row.embed_version).toBe(2);
    expect(row.embed_content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('embeds knowledge rows with NULL embedding too (effective-domain folded)', async () => {
    await db.insert(knowledge).values({
      id: 'k1',
      name: '虚词',
      domain: '古文',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const { runEmbedBackfill } = await import('./embed_backfill');
    const n = await runEmbedBackfill(db, 50);
    expect(n).toBe(1);
    const [row] = await db.select().from(knowledge).where(eq(knowledge.id, 'k1'));
    expect(row.embedding).toHaveLength(1024);
    expect(row.embed_version).toBe(2);
    expect(row.embed_content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent — second run embeds nothing (no stale rows left)', async () => {
    await db.insert(question).values({
      id: 'q1',
      kind: 'single_choice',
      prompt_md: 'P',
      source: 'authentic',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const { runEmbedBackfill } = await import('./embed_backfill');
    await runEmbedBackfill(db, 50);
    embedMany.mockClear();
    const n2 = await runEmbedBackfill(db, 50);
    expect(n2).toBe(0);
    expect(embedMany).not.toHaveBeenCalled();
  });

  // YUK-393 — corpus re-embed: a row stamped behind EMBED_VERSION is re-picked.
  it('re-embeds a row stamped with an older embed_version', async () => {
    await db.insert(question).values({
      id: 'q1',
      kind: 'single_choice',
      prompt_md: 'P',
      source: 'authentic',
      embedding: Array(1024).fill(0.5),
      embed_model: 'old-model',
      embed_version: 1, // behind EMBED_VERSION=2
      embed_content_hash: 'stale',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const { runEmbedBackfill } = await import('./embed_backfill');
    const n = await runEmbedBackfill(db, 50);
    expect(n).toBe(1);
    const [row] = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(row.embed_version).toBe(2);
    expect(row.embed_model).toBe('text-embedding-v4');
  });

  // YUK-393 — full edit → re-embed loop. A content edit NULLs the embedding; the
  // next backfill re-embeds it with a fresh hash.
  it('editQuestion content change → embedding NULLed → backfill re-embeds', async () => {
    await db.insert(question).values({
      id: 'q1',
      kind: 'short_answer',
      prompt_md: 'P',
      source: 'authentic',
      version: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const { runEmbedBackfill } = await import('./embed_backfill');
    await runEmbedBackfill(db, 50);
    const [embedded] = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(embedded.embedding).toHaveLength(1024);
    const originalHash = embedded.embed_content_hash;

    const { editQuestion } = await import('@/server/questions/write');
    const res = await editQuestion(db, 'q1', 0, { prompt_md: 'P-changed' }, 'user:test');
    expect(res.status).toBe('updated');
    const [afterEdit] = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(afterEdit.embedding).toBeNull();
    expect(afterEdit.embed_content_hash).not.toBe(originalHash);

    embedMany.mockClear();
    const n = await runEmbedBackfill(db, 50);
    expect(n).toBe(1);
    expect(embedMany).toHaveBeenCalledTimes(1);
    const [reEmbedded] = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(reEmbedded.embedding).toHaveLength(1024);
  });

  // YUK-393 — no-op / non-content edit must NOT touch the embedding and must NOT
  // call the embedder.
  it('editQuestion difficulty-only change leaves embedding intact, no re-embed', async () => {
    await db.insert(question).values({
      id: 'q1',
      kind: 'short_answer',
      prompt_md: 'P',
      difficulty: 3,
      source: 'authentic',
      version: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const { runEmbedBackfill } = await import('./embed_backfill');
    await runEmbedBackfill(db, 50);
    const [embedded] = await db.select().from(question).where(eq(question.id, 'q1'));
    const originalHash = embedded.embed_content_hash;

    const { editQuestion } = await import('@/server/questions/write');
    const res = await editQuestion(db, 'q1', 0, { difficulty: 5 }, 'user:test');
    expect(res.status).toBe('updated');
    const [afterEdit] = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(afterEdit.embedding).toHaveLength(1024);
    expect(afterEdit.embed_content_hash).toBe(originalHash);

    embedMany.mockClear();
    const n = await runEmbedBackfill(db, 50);
    expect(n).toBe(0);
    expect(embedMany).not.toHaveBeenCalled();
  });

  // YUK-393 — reparent across domains NULLs the moved KC's embedding (KC-only).
  it('applyReparent cross-domain → moved KC embedding NULLed', async () => {
    const now = new Date();
    // Two subject roots + a child under the first root.
    await db.insert(knowledge).values([
      { id: 'rootA', name: 'A', domain: '物理', version: 0, created_at: now, updated_at: now },
      { id: 'rootB', name: 'B', domain: '化学', version: 0, created_at: now, updated_at: now },
      {
        id: 'kc',
        name: '周期',
        domain: null,
        parent_id: 'rootA',
        version: 0,
        created_at: now,
        updated_at: now,
      },
    ]);
    const { runEmbedBackfill } = await import('./embed_backfill');
    await runEmbedBackfill(db, 50);
    const [before] = await db.select().from(knowledge).where(eq(knowledge.id, 'kc'));
    expect(before.embedding).toHaveLength(1024);

    const { applyReparent } = await import('@/capabilities/knowledge/server/proposals');
    await applyReparent(db, {
      mutation: 'reparent',
      node_id: 'kc',
      new_parent_id: 'rootB',
      expected_version: 0,
    });
    const [after] = await db.select().from(knowledge).where(eq(knowledge.id, 'kc'));
    expect(after.embedding).toBeNull();
    // Sibling roots untouched.
    const [rootA] = await db.select().from(knowledge).where(eq(knowledge.id, 'rootA'));
    expect(rootA.embedding).toHaveLength(1024);
  });

  // YUK-393 F1 — a KC whose effective-domain resolution THROWS (broken tree:
  // child under a root with null domain → invariant-violation throw) must be
  // SKIPPED, not stamped: its embedding/version stay untouched so the next
  // backfill retries it, and it must never be frozen with a degraded vector.
  // A healthy sibling in the same batch still embeds.
  it('getEffectiveDomain throw → row skipped (not stamped), healthy sibling still embeds', async () => {
    const now = new Date();
    // badRoot: root with null domain (invariant violation) → throws on itself.
    // badChild: walks up to badRoot → also throws.
    // okRoot: healthy root resolves to its own domain.
    await db.insert(knowledge).values([
      {
        id: 'badRoot',
        name: 'bad',
        domain: null,
        parent_id: null,
        version: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'badChild',
        name: '坏',
        domain: null,
        parent_id: 'badRoot',
        version: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'okRoot',
        name: '好',
        domain: '物理',
        parent_id: null,
        version: 0,
        created_at: now,
        updated_at: now,
      },
    ]);
    const { runEmbedBackfill } = await import('./embed_backfill');
    const n = await runEmbedBackfill(db, 50);

    // Only the resolvable row is embedded + stamped + counted.
    expect(n).toBe(1);
    const [okRow] = await db.select().from(knowledge).where(eq(knowledge.id, 'okRoot'));
    expect(okRow.embedding).toHaveLength(1024);
    expect(okRow.embed_version).toBe(2);
    expect(okRow.embed_content_hash).toMatch(/^[0-9a-f]{64}$/);

    // The throwing rows are left fully untouched — NULL embedding + NULL version
    // + NULL hash → the select predicate re-picks them next backfill.
    const [badChild] = await db.select().from(knowledge).where(eq(knowledge.id, 'badChild'));
    expect(badChild.embedding).toBeNull();
    expect(badChild.embed_version).toBeNull();
    expect(badChild.embed_content_hash).toBeNull();
    const [badRoot] = await db.select().from(knowledge).where(eq(knowledge.id, 'badRoot'));
    expect(badRoot.embedding).toBeNull();
    expect(badRoot.embed_version).toBeNull();

    // A second backfill must STILL see the throwing rows as stale (never frozen).
    const ks2 = await db.select().from(knowledge);
    const stillStale = ks2.filter((k) => k.embed_version === null).map((k) => k.id);
    expect(stillStale.sort()).toEqual(['badChild', 'badRoot']);
  });

  // YUK-393 F2 — parallel effective-domain resolution across the batch must keep
  // each row mapped to ITS OWN domain. Two same-named KCs under different subject
  // roots get DISTINCT embed text → distinct content hash (no cross-wiring).
  it('parallel effective-domain resolution maps each row to its own domain', async () => {
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'rPhys',
        name: 'P',
        domain: '物理',
        parent_id: null,
        version: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'rChem',
        name: 'C',
        domain: '化学',
        parent_id: null,
        version: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'kPhys',
        name: '周期',
        domain: null,
        parent_id: 'rPhys',
        version: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'kChem',
        name: '周期',
        domain: null,
        parent_id: 'rChem',
        version: 0,
        created_at: now,
        updated_at: now,
      },
    ]);
    const { embedHash, knowledgeEmbedText } = await import('@/server/ai/embed-source');
    const { runEmbedBackfill } = await import('./embed_backfill');
    const n = await runEmbedBackfill(db, 50);
    expect(n).toBe(4);

    const [kPhys] = await db.select().from(knowledge).where(eq(knowledge.id, 'kPhys'));
    const [kChem] = await db.select().from(knowledge).where(eq(knowledge.id, 'kChem'));
    // Each same-named child resolved to its OWN effective domain → distinct hash.
    expect(kPhys.embed_content_hash).toBe(
      embedHash(knowledgeEmbedText({ name: '周期', effectiveDomain: '物理' })),
    );
    expect(kChem.embed_content_hash).toBe(
      embedHash(knowledgeEmbedText({ name: '周期', effectiveDomain: '化学' })),
    );
    expect(kPhys.embed_content_hash).not.toBe(kChem.embed_content_hash);
  });

  // YUK-393 — reparent WITHIN the same domain is a no-op for the embedding.
  it('applyReparent same-domain → moved KC embedding NOT NULLed', async () => {
    const now = new Date();
    await db.insert(knowledge).values([
      { id: 'rootA', name: 'A', domain: '物理', version: 0, created_at: now, updated_at: now },
      {
        id: 'mid',
        name: 'mid',
        domain: null,
        parent_id: 'rootA',
        version: 0,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'kc',
        name: '周期',
        domain: null,
        parent_id: 'rootA',
        version: 0,
        created_at: now,
        updated_at: now,
      },
    ]);
    const { runEmbedBackfill } = await import('./embed_backfill');
    await runEmbedBackfill(db, 50);
    const [before] = await db.select().from(knowledge).where(eq(knowledge.id, 'kc'));
    expect(before.embedding).toHaveLength(1024);

    // Move kc from rootA directly to under mid — still resolves to 物理.
    const { applyReparent } = await import('@/capabilities/knowledge/server/proposals');
    await applyReparent(db, {
      mutation: 'reparent',
      node_id: 'kc',
      new_parent_id: 'mid',
      expected_version: 0,
    });
    const [after] = await db.select().from(knowledge).where(eq(knowledge.id, 'kc'));
    expect(after.embedding).toHaveLength(1024);
  });
});
