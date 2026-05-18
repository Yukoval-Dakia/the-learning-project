// `/api/mistakes/recent` projects learning_record(kind='mistake') plus linked
// attempt events to the legacy mistake-shape wire contract.
//
// Wire contract unchanged from the legacy mistake-shape:
//   GET /api/mistakes/recent?limit=N
//     → { rows: [{ id, question_id, prompt_md, wrong_answer_md, knowledge_ids,
//                  cause, created_at }] }
//
// Implementation reads failure attempts from the event log via
// `getFailureAttempts` (Step 4) then projects to mistake-shape JSON. Question
// prompts are batch-fetched via `inArray` to avoid N+1.
//
// `cause.user_notes` is preserved as `null` for back-compat (Lane B dropped
// the field per ADR-0006 v2; product accepts the data loss).

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { listMistakeProjectionRows } from '@/server/records/mistakes';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get('limit');
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    const limit = Math.min(Math.max(Number.isNaN(limitParsed) ? 20 : limitParsed, 1), 100);

    const rows = await listMistakeProjectionRows(db, { limit });

    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
