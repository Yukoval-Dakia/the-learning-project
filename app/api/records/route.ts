import { z } from 'zod';

import {
  LearningRecordActivityKind,
  LearningRecordCaptureMode,
  LearningRecordKind,
  LearningRecordProcessingStatus,
  LearningRecordSource,
} from '@/core/schema';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { createLearningRecord, listLearningRecords } from '@/server/records/queries';

export const runtime = 'nodejs';

const ListQuery = z.object({
  kind: z.union([LearningRecordKind, z.array(LearningRecordKind)]).optional(),
  knowledge_id: z.string().min(1).optional(),
  question_id: z.string().min(1).optional(),
  attempt_event_id: z.string().min(1).optional(),
  activity_kind: z.string().min(1).optional(),
  processing_status: LearningRecordProcessingStatus.optional(),
  limit: z
    .string()
    .optional()
    .refine((s) => s === undefined || /^\d+$/.test(s), {
      message: 'limit must be a positive integer',
    }),
});

const CreateBody = z.object({
  kind: LearningRecordKind,
  title: z.string().nullable().optional(),
  content_md: z.string().min(1).max(20_000),
  source: LearningRecordSource,
  capture_mode: LearningRecordCaptureMode,
  activity_kind: LearningRecordActivityKind,
  processing_status: LearningRecordProcessingStatus.default('raw'),
  origin_event_id: z.string().min(1).nullable().optional(),
  subject_id: z.string().min(1).nullable().optional(),
  knowledge_ids: z.array(z.string().min(1)).default([]),
  question_id: z.string().min(1).nullable().optional(),
  attempt_event_id: z.string().min(1).nullable().optional(),
  learning_item_id: z.string().min(1).nullable().optional(),
  artifact_id: z.string().min(1).nullable().optional(),
  source_document_id: z.string().min(1).nullable().optional(),
  asset_refs: z.array(z.string().min(1)).default([]),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function toEpoch(row: { created_at: Date; updated_at: Date; archived_at: Date | null }) {
  return {
    created_at: Math.floor(row.created_at.getTime() / 1000),
    updated_at: Math.floor(row.updated_at.getTime() / 1000),
    archived_at: row.archived_at ? Math.floor(row.archived_at.getTime() / 1000) : null,
  };
}

function serializeRecord<
  T extends { created_at: Date; updated_at: Date; archived_at: Date | null },
>(row: T) {
  return { ...row, ...toEpoch(row) };
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const raw: Record<string, string | string[]> = {};
    for (const key of url.searchParams.keys()) {
      const values = url.searchParams.getAll(key);
      raw[key] = values.length > 1 ? values : (values[0] ?? '');
    }
    const parsed = ListQuery.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const limit = Math.min(
      Math.max(parsed.data.limit ? Number.parseInt(parsed.data.limit, 10) : DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const kind =
      parsed.data.kind === undefined
        ? undefined
        : Array.isArray(parsed.data.kind)
          ? parsed.data.kind
          : [parsed.data.kind];
    const rows = await listLearningRecords(db, {
      kind,
      knowledge_id: parsed.data.knowledge_id,
      question_id: parsed.data.question_id,
      attempt_event_id: parsed.data.attempt_event_id,
      activity_kind: parsed.data.activity_kind,
      processing_status: parsed.data.processing_status
        ? [parsed.data.processing_status]
        : undefined,
      limit,
    });
    return Response.json({ rows: rows.map(serializeRecord) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = CreateBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const result = await db.transaction((tx) =>
      createLearningRecord(tx, {
        ...parsed.data,
        create_capture_event: parsed.data.origin_event_id == null,
      }),
    );
    return Response.json(serializeRecord(result.record));
  } catch (err) {
    return errorResponse(err);
  }
}
