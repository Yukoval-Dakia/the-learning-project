// YUK-203 U4 / D11① — listActiveLearningItems DB test.

import { beforeEach, describe, expect, it } from 'vitest';

import { learning_item } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { listActiveLearningItems } from './queries';

const db = testDb();

async function seedItem(opts: {
  id: string;
  status: string;
  user_pinned: boolean;
  knowledge_ids?: string[];
  archived_at?: Date | null;
}) {
  const now = new Date();
  await db.insert(learning_item).values({
    id: opts.id,
    source: 'test',
    title: opts.id,
    knowledge_ids: opts.knowledge_ids ?? [],
    status: opts.status,
    user_pinned: opts.user_pinned,
    archived_at: opts.archived_at ?? null,
    created_at: now,
    updated_at: now,
  });
}

describe('listActiveLearningItems', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns only in_progress OR pinned items, never pending/archived non-pinned', async () => {
    await seedItem({ id: 'li_in_progress', status: 'in_progress', user_pinned: false });
    await seedItem({
      id: 'li_pinned_pending',
      status: 'pending',
      user_pinned: true,
      knowledge_ids: ['k_yu'],
    });
    await seedItem({ id: 'li_pending', status: 'pending', user_pinned: false });
    await seedItem({ id: 'li_archived', status: 'archived', user_pinned: false });

    const items = await listActiveLearningItems(db);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(['li_in_progress', 'li_pinned_pending']);
    const pinned = items.find((i) => i.id === 'li_pinned_pending');
    expect(pinned?.knowledge_ids).toEqual(['k_yu']);
    expect(pinned?.user_pinned).toBe(true);
  });

  it('returns empty when no active/pinned items exist', async () => {
    await seedItem({ id: 'li_pending', status: 'pending', user_pinned: false });
    expect(await listActiveLearningItems(db)).toEqual([]);
  });

  // codex PR #298 #3357932406 — soft-deleted items (archived_at set) are
  // excluded even when status / user_pinned still match. The DELETE route only
  // sets archived_at; it does NOT flip status or clear the pin.
  it('excludes archived items even when still in_progress or pinned', async () => {
    const archivedAt = new Date();
    await seedItem({
      id: 'li_in_progress_active',
      status: 'in_progress',
      user_pinned: false,
    });
    await seedItem({
      id: 'li_in_progress_archived',
      status: 'in_progress',
      user_pinned: false,
      archived_at: archivedAt,
    });
    await seedItem({
      id: 'li_pinned_archived',
      status: 'pending',
      user_pinned: true,
      archived_at: archivedAt,
    });

    const ids = (await listActiveLearningItems(db)).map((i) => i.id).sort();
    expect(ids).toEqual(['li_in_progress_active']);
  });
});
