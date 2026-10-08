import { z } from 'zod';
import { AiProposalKind } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { ApiError, collectionPayload } from '@/kernel/http';
import { listProposalInboxPage } from '@/kernel/proposals/inbox';

// Retain the HTTP policy; the domain reader's omitted limit means unlimited.
const ProposalInboxQuery = z.object({
  status: z.string().optional(),
  kind: z.string().optional(),
  lane: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});
export type ProposalInboxQuery = z.input<typeof ProposalInboxQuery>;

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 200;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError('validation_error', `invalid limit: ${value}`, 400);
  }
  return Math.min(parsed, 500);
}

function parseFilter<T>(schema: z.ZodType<T>, value: string | undefined, label: string) {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError('validation_error', `invalid proposal ${label}: ${value}`, 400);
  }
  return parsed.data;
}

export async function readProposalInbox(db: Db, input: unknown = {}) {
  const parsed = ProposalInboxQuery.safeParse(input);
  if (!parsed.success) throw new ApiError('validation_error', 'invalid proposal query', 400);
  const query = parsed.data;
  const limit = parseLimit(query.limit);
  const page = await listProposalInboxPage(db, {
    status: parseFilter(
      z.enum(['pending', 'accepted', 'dismissed', 'stale', 'rubric_rejected']),
      query.status,
      'status',
    ),
    kind: parseFilter(AiProposalKind, query.kind, 'kind'),
    lane: parseFilter(z.enum(['decision', 'observation']), query.lane, 'lane'),
    limit,
    cursor: query.cursor,
  });
  const rows = page.rows.map((row) => ({
    ...row,
    proposed_at: row.proposed_at.toISOString(),
    decided_at: row.decided_at?.toISOString() ?? null,
  }));
  return collectionPayload(
    rows,
    { limit, next_cursor: page.next_cursor },
    {
      rows,
      next_cursor: page.next_cursor,
    },
  );
}
