// Phase 1c.1 Step 9.B — `/api/review/due` over `material_fsrs_state`.
//
// Next App Router route modules may ONLY export route handlers (GET/POST/...)
// plus recognized config (runtime/dynamic/...). The actual handler logic —
// including the YUK-167 goal soft-bias re-rank and its deps-injectable seam —
// lives in @/server/review/due-list so it can be unit/DB-tested without the
// route module growing extra exports that `next build` rejects (YUK-67).
//
// Wire contract preserved: { rows: [{ id, question_id, prompt_md, reference_md,
// knowledge_ids, cause, fsrs_state, created_at }] }.

import { handleReviewDue } from '@/server/review/due-list';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  return handleReviewDue(req);
}
