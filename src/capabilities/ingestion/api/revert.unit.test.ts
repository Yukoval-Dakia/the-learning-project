import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit test: mock the DB client + the server primitive so the route is exercised
// in isolation (HTTP shape + status mapping). The primitive itself is DB-tested
// in src/capabilities/ingestion/server/revert-auto-enroll.db.test.ts.
vi.mock('@/db/client', () => ({ db: {} }));
const revertAutoEnrolledBlock = vi.fn();
vi.mock('@/capabilities/ingestion/server/revert-auto-enroll', () => ({
  revertAutoEnrolledBlock: (...args: unknown[]) => revertAutoEnrolledBlock(...args),
}));

import { ApiError } from '@/server/http/errors';
import { POST } from './revert';

const ctx = { id: 'sess_1' };

function req(body: unknown): Request {
  return new Request('http://t/api/ingestion/sess_1/revert', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/ingestion/[id]/revert', () => {
  beforeEach(() => {
    revertAutoEnrolledBlock.mockReset();
  });

  it('reverts a block and returns the result', async () => {
    revertAutoEnrolledBlock.mockResolvedValue({
      questionId: 'q1',
      recordId: 'r1',
      retractEventId: 'e_retract',
      retractedEventId: 'e_attempt',
    });
    const res = await POST(req({ block_id: 'b1', reason_md: 'wrong tag' }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ questionId: 'q1', retractEventId: 'e_retract' });
    expect(revertAutoEnrolledBlock).toHaveBeenCalledWith(expect.anything(), {
      blockId: 'b1',
      sessionId: 'sess_1',
      reasonMd: 'wrong tag',
    });
  });

  it('rejects a body without block_id (400)', async () => {
    const res = await POST(req({ reason_md: 'x' }), ctx);
    expect(res.status).toBe(400);
    expect(revertAutoEnrolledBlock).not.toHaveBeenCalled();
  });

  it('maps an ApiError(409) from the primitive to a 409 response', async () => {
    revertAutoEnrolledBlock.mockRejectedValue(
      new ApiError('conflict', "block is 'draft'; only 'auto_enrolled' can be reverted", 409),
    );
    const res = await POST(req({ block_id: 'b1' }), ctx);
    expect(res.status).toBe(409);
  });
});
