// Admin subject enumeration, including general and retired, for the editor. The
// response carries the CAS revision but never full profile fields; writes stay on
// /api/admin/*.

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { listAdminSubjects } from '../public';

export async function GET(): Promise<Response> {
  try {
    const subjects = await listAdminSubjects(db);
    return Response.json({ subjects });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function getSubject(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const subjects = await listAdminSubjects(db);
    const subject = subjects.find((candidate) => candidate.id === params.id);
    if (!subject) throw new ApiError('not_found', `subject ${params.id} not found`, 404);
    return Response.json(subject);
  } catch (err) {
    return errorResponse(err);
  }
}
