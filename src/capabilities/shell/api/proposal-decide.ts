// M4-T5 (YUK-319)：旧 app/api/proposals/[id]/{accept,dismiss} 两路由合并为单
// decide 端点（kernel v2 (req, params) 签名）。decision 必填四值——'dismiss'
// 走 dismissAiProposal，其余三值走 acceptAiProposal（旧 AcceptBody 的
// optional decision 缺省语义由显式 'accept' 承担）；superRefine 约束照旧。

import { RelationTypeSchema } from '@/core/schema/event/blocks';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { acceptAiProposal, dismissAiProposal } from '@/server/proposals/actions';
import { z } from 'zod';

const DecideBody = z
  .object({
    decision: z.enum(['accept', 'reverse', 'change_type', 'dismiss']),
    new_relation_type: RelationTypeSchema.optional(),
    user_note: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.decision === 'change_type' && !data.new_relation_type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'change_type requires new_relation_type',
        path: ['new_relation_type'],
      });
    }
  });

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id } = params;
    if (!id) {
      throw new ApiError('validation_error', 'proposal id is required', 400);
    }
    const raw = await req.json().catch(() => ({}));
    const parsed = DecideBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { decision, new_relation_type, user_note } = parsed.data;
    const result =
      decision === 'dismiss'
        ? await dismissAiProposal(db, id, { user_note })
        : await acceptAiProposal(db, id, { decision, new_relation_type, user_note });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
