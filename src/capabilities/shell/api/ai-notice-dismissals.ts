// GET/POST /api/workbench/ai-notices/dismissals route shell; the ledger is server/ai-notice-dismissals.ts.

import {
  dismissAiNotices,
  listDismissedAiNotices,
} from '@/capabilities/shell/server/ai-notice-dismissals';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { AiNoticeDismissBodySchema } from './contracts';

export async function GET(): Promise<Response> {
  try {
    return Response.json({ keys: await listDismissedAiNotices(db) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    // An unparseable body is a validation failure, not a swallowed 500.
    const raw = await req.json().catch(() => null);
    const parsed = AiNoticeDismissBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    return Response.json(await dismissAiNotices(db, parsed.data.keys));
  } catch (err) {
    return errorResponse(err);
  }
}
