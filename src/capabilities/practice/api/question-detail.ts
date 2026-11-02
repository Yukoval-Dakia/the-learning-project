// GET /api/questions/[id]: the question-bank detail read.
// PATCH (edit) + DELETE (archive with an association-count guard).
//
// GET: single-fetch detail aggregator (row + source_tier + labels + variant
// family + per-knowledge FSRS/decay + backlinks + timeline).
// PATCH: edit the question-bank editable surface (prompt/reference/choices/
//   difficulty/knowledge_ids/kind/draft_status); bloodline fields rejected.
// DELETE: returns association counts + 409 unless ?confirm=true; soft-archives
//   by re-drafting (see src/capabilities/practice/server/question-bank-write.ts header).
//
// Auth is enforced upstream by middleware (x-internal-token); the handlers mirror
// the sibling notes/learning-items routes (zod, 404 on missing, errorResponse).

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { readQuestionDetail } from '../server/question-detail-read';
import {
  archivePracticeQuestion,
  updatePracticeQuestion,
} from '../server/question-write-operations';

export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const url = new URL(req.url);
    const detail = await readQuestionDetail(db, params, {
      timelineLimit: url.searchParams.get('timeline_limit'),
      surface: url.searchParams.get('surface'),
    });
    return Response.json(detail);
  } catch (err) {
    return errorResponse(err);
  }
}

// ── PATCH — edit the question-bank editable surface ─────────────────────────
export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await updatePracticeQuestion(db, params, () => req.json()));
  } catch (err) {
    return errorResponse(err);
  }
}

// ── DELETE — association-count guard + soft-archive ─────────────────────────
// Two-step:
//   1. no `?confirm=true`  → return association counts + 409 ('confirm_required')
//      so the UI can show the "N 条作答 / N 张复习卡 / N 份卷引用 / N 条错题 / N 道小题" warning.
//      When the question has ZERO associations we still require confirm for a
//      uniform UI flow (cheap), but the counts are all 0.
//   2. `?confirm=true`     → soft-archive (re-draft) + cascade parts + event.
//      When children exist, `?confirm_children=true` is additionally required.
//      This fail-closed protocol prevents an older web bundle from silently
//      confirming a cascade after a newer API starts reporting child counts.
export async function DELETE(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const result = await archivePracticeQuestion(db, params, () => new URL(req.url).searchParams);
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    return errorResponse(err);
  }
}
