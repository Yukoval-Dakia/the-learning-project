// Read-only coverage lattice: the scanner's four pool rules, emitted gap targets and
// recent supply activity. Auth is enforced upstream.
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { loadCoverageLattice } from '@/kernel/read-models/coverage-lattice';

export async function GET(): Promise<Response> {
  try {
    const result = await loadCoverageLattice(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
