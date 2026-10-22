// Both transports grade the persisted probe original through one complete operation.
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { submitConjectureProbeAnswer } from '../server/conjecture/probe-answer-operation';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(
      await submitConjectureProbeAnswer(db, params, () => req.json(), req.signal),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
