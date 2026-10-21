// Six trait bindings per subject. Live revision and effective revision are separate,
// so a degraded trait still shows what is actually in use.

import { z } from 'zod';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { getAdminSubjectTraits } from '../public';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
      return Response.json({ error: 'subject id is required' }, { status: 400 });
    }
    const result = await getAdminSubjectTraits(db, parsed.data.id);
    if (result === null) {
      return Response.json({ error: `unknown subject "${parsed.data.id}"` }, { status: 404 });
    }
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
