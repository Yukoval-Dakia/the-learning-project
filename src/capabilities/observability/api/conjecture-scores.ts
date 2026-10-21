// Read-only conjecture calibration surface: live prediction scores plus the
// not-yet-energized confused-with-X rows. Auth is enforced upstream.
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { loadConjectureScores } from '../public';

export async function GET(): Promise<Response> {
  try {
    const result = await loadConjectureScores(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
