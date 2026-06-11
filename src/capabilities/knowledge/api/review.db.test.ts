import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST } from './review';

// Mock streamReviewTask to avoid real LLM calls
vi.mock('@/capabilities/knowledge/server/review', () => ({
  streamReviewTask: vi.fn().mockResolvedValue(new Response('ok', { status: 200 })),
}));

const KNOWLEDGE_BASE = {
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

async function postReview() {
  return POST();
}

describe('POST /api/knowledge/review', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('handler is mounted — does not return 404', async () => {
    const res = await postReview();
    expect(res.status).not.toBe(404);
  });

  it('calls streamReviewTask and returns its response', async () => {
    const { streamReviewTask } = await import('@/capabilities/knowledge/server/review');
    vi.mocked(streamReviewTask).mockResolvedValueOnce(new Response('streamed', { status: 200 }));

    const res = await postReview();
    expect(res.status).toBe(200);
    expect(streamReviewTask).toHaveBeenCalled();
  });
});
