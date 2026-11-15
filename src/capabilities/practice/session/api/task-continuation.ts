import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { commandPaperTask, readPaperTaskContinuation } from '../server/task-continuation';
import {
  ReadPaperContinuationQuerySchema,
  RecordPaperStepBodySchema,
  ResumePaperTaskBodySchema,
} from './task-continuation-contracts';

export async function GET(req: Request, params: Record<string, string>) {
  try {
    const parsed = ReadPaperContinuationQuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!parsed.success) throw new ApiError('validation_error', '需要有效的 occurrence_ref', 400);
    const query = parsed.data;
    return Response.json(
      await readPaperTaskContinuation(db, {
        kind: 'paper_review',
        session_id: params.id,
        occurrence_ref: query.occurrence_ref,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

async function command(
  req: Request,
  params: Record<string, string>,
  action: 'resume' | 'navigate',
) {
  try {
    const raw: unknown = await req.json().catch(() => null);
    const parsed =
      action === 'resume'
        ? ResumePaperTaskBodySchema.safeParse(raw)
        : RecordPaperStepBodySchema.safeParse(raw);
    if (!parsed.success)
      throw new ApiError('validation_error', '需要有效的会话、版本和命令标识', 400);
    const body = parsed.data;
    if (body.task_ref.session_id !== params.id)
      throw new ApiError('coordinate_mismatch', '路径与指定会话不一致', 409);
    return Response.json(
      await commandPaperTask(
        db,
        body,
        action === 'navigate' ? 'navigate' : 'action' in body ? body.action : 'resume',
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export const POST = (req: Request, params: Record<string, string>) =>
  command(req, params, 'resume');
export const PATCH = (req: Request, params: Record<string, string>) =>
  command(req, params, 'navigate');
