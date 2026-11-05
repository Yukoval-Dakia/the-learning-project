// POST /api/questions/[id]/serving-actions/[command]:
// command surface for releasing a held question (serving-holds UI contract v2).
//
//   release_verify_hold sync  — clear verify_hold via the publisher's
//                        dimension-only path; never touches retraction_hold,
//                        never mints a revision
//
//   recheck_source  — system-only source_verify recovery after lane repair
//                        (outbox recovery_epoch owns re-dispatch; no operator POST)
//
// reverify stays a system duty driven by result events and the recovery pass
// (auto:<group>:<digest>:<command>:<n> ledger keys); old clients posting either
// system command get the params-schema 400.
//
// Every command requires an Idempotency-Key header and returns
// {accepted, serving} where serving is the same projection the list/detail
// reads emit. accepted=false when the command does not apply to the current
// hold (a replay of a rejected command is still idempotent).
//
// Auth is enforced upstream by middleware (x-internal-token); the handler
// mirrors the sibling question routes (zod, ApiError, errorResponse).

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { runPracticeServingAction } from '../server/serving-action-operation';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const result = await runPracticeServingAction(db, params, req.headers.get('idempotency-key'));
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
