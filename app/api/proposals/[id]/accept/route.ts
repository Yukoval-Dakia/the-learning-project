import { z } from 'zod';

import { RelationTypeSchema } from '@/core/schema/event/blocks';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { acceptAiProposal } from '@/server/proposals/actions';

export const runtime = 'nodejs';

const AcceptBody = z
  .object({
    decision: z.enum(['accept', 'reverse', 'change_type']).optional(),
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

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    const raw = await req.json().catch(() => ({}));
    const parsed = AcceptBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const result = await acceptAiProposal(db, id, parsed.data);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
