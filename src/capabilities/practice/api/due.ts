// GET /api/review/due over `material_fsrs_state`.
//
// The handler and its goal soft-bias re-rank live in server/due-list so they
// stay testable without this module growing extra exports.
//
// Wire contract: { rows: [{ id, question_id, prompt_md, reference_md,
// knowledge_ids, cause, fsrs_state, created_at }] }.

import { handleReviewDue } from '@/capabilities/practice/server/due-list';

export async function GET(req: Request): Promise<Response> {
  return handleReviewDue(req);
}
