// Cross-subject trait catalog, used as the rebind selector. `kind` is required and
// must be one of the six trait kinds.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { SUBJECT_TRAIT_KINDS, type SubjectTraitKind } from '@/subjects/trait-schemas';
import { listAdminTraits } from '../public';

export async function GET(req: Request): Promise<Response> {
  try {
    const kind = new URL(req.url).searchParams.get('kind');
    if (!kind || !(SUBJECT_TRAIT_KINDS as readonly string[]).includes(kind)) {
      return Response.json(
        { error: `kind query is required (one of: ${SUBJECT_TRAIT_KINDS.join(', ')})` },
        { status: 400 },
      );
    }
    const traits = await listAdminTraits(db, kind as SubjectTraitKind);
    return Response.json({ traits });
  } catch (err) {
    return errorResponse(err);
  }
}
