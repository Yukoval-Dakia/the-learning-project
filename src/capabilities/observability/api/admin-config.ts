// Read-only admin config. Assembly lives in the read model; this is only the HTTP
// boundary, with auth enforced upstream.
import { errorResponse } from '@/kernel/http';

import { buildAdminConfigReadModel, getAdminConfigRuntimeFacts } from '../public';

export async function GET(): Promise<Response> {
  try {
    return Response.json(buildAdminConfigReadModel(process.env, getAdminConfigRuntimeFacts()));
  } catch (err) {
    return errorResponse(err);
  }
}
