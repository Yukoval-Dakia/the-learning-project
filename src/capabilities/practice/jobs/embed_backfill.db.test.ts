import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { resetDb } from '../../../../tests/helpers/db';

vi.mock('@/server/ai/embed', () => ({
  embedMany: vi.fn(async (texts: string[]) => texts.map(() => Array(1024).fill(0.02))),
  EMBED_MODEL: 'text-embedding-v4',
  EMBED_DIMS: 1024,
}));

describe('embed_backfill', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('embeds question rows with NULL embedding and stamps model/version', async () => {
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
    expect(row.embed_version).toBe(1);
  });

  it('embeds knowledge rows with NULL embedding too', async () => {
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
    expect(row.embed_version).toBe(1);
  });

  it('is idempotent — second run embeds nothing (no NULL rows left)', async () => {
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
    const n2 = await runEmbedBackfill(db, 50);
    expect(n2).toBe(0);
  });
});
