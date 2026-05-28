// Wave 5 / T-D3/B — GET /api/today/copilot-summary
//
// Powers the Copilot Drawer summary slot on /today. Read-only composer
// over Coach scan + Dreaming preview + pending proposal totals. Returns
// {@link CopilotSummary}.

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { loadCopilotSummary } from '@/server/today/copilot-summary';

export const runtime = 'nodejs';

export async function GET(_req: Request): Promise<Response> {
  try {
    return Response.json(await loadCopilotSummary(db));
  } catch (err) {
    return errorResponse(err);
  }
}
