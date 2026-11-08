import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { listProposalBatchAccepts } from '../server/batch-accepts-read';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await listProposalBatchAccepts(db));
  } catch (err) {
    return errorResponse(err);
  }
}
