import { z } from 'zod';

import { LearningRecordProcessingStatus } from '@/core/schema';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import {
  archiveLearningRecord,
  getLearningRecord,
  updateLearningRecord,
} from '@/server/records/queries';
// YUK-15 — attach proposal_count on GET so the detail card shows the backlink.
import { getProposalCountsForRecords } from '@/server/records/record_processing';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

const PatchBody = z.object({
  title: z.string().nullable().optional(),
  content_md: z.string().min(1).max(20_000).optional(),
  knowledge_ids: z.array(z.string().min(1)).optional(),
  processing_status: LearningRecordProcessingStatus.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  version: z.number().int().min(0),
});

function serializeRecord(row: {
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}) {
  return {
    ...row,
    created_at: Math.floor(row.created_at.getTime() / 1000),
    updated_at: Math.floor(row.updated_at.getTime() / 1000),
    archived_at: row.archived_at ? Math.floor(row.archived_at.getTime() / 1000) : null,
  };
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    const record = await getLearningRecord(db, id);
    if (!record) throw new ApiError('not_found', `learning_record ${id} not found`, 404);
    const counts = await getProposalCountsForRecords(db, [record.id]);
    return Response.json({
      ...serializeRecord(record),
      proposal_count: counts.get(record.id) ?? 0,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    const raw = await req.json().catch(() => null);
    const parsed = PatchBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const record = await updateLearningRecord(db, id, parsed.data);
    return Response.json(serializeRecord(record));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    await archiveLearningRecord(db, id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
