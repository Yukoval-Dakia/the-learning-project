// POST /api/questions/[id]/restore: the restore (un-archive) write.
//
// Un-tombstones a soft-archived question back to draft, clears the withdrawn
// lifecycle dimension, and atomically re-acquires the live dedup claim (the
// canonical_content_hash retained on metadata.archived_content_hash at
// archive time). Cascade-archived composite parts (archived_via_parent=this id)
// are restored with it; a claim conflict on ANY member rolls the whole restore
// back with 409 (no half-restored groups).
//
// Verify suspension is NOT lifted here — suspended groups stay suspended until
// a same-version re-verify passes.
//
// Auth is enforced upstream by middleware (x-internal-token); the handler
// mirrors the sibling DELETE's error mapping.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { restorePracticeQuestion } from '../server/question-restore-operation';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await restorePracticeQuestion(db, params, () => req.json()));
  } catch (err) {
    return errorResponse(err);
  }
}
