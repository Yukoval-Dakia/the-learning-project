import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { type ProposalStatus, listProposalInboxPage } from '@/server/proposals/inbox';

export const runtime = 'nodejs';

// P5.4 / YUK-143 (RB-8) — 'rubric_rejected' is queryable so the folded /
// low-visibility bucket of rubric-rejected proposals is exposed to clients via
// `?status=rubric_rejected`. Backend substrate only; the folded inbox rendering
// is deferred to the claude-design redraw.
const proposalStatuses = new Set<ProposalStatus>([
  'pending',
  'accepted',
  'dismissed',
  'stale',
  'rubric_rejected',
]);

function parseStatus(value: string | null): ProposalStatus | undefined {
  if (value === null) return undefined;
  if (proposalStatuses.has(value as ProposalStatus)) return value as ProposalStatus;
  throw new ApiError('validation_error', `invalid proposal status: ${value}`, 400);
}

function parseLimit(value: string | null): number {
  if (value === null) return 200;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError('validation_error', `invalid limit: ${value}`, 400);
  }
  return Math.min(parsed, 500);
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const page = await listProposalInboxPage(db, {
      status: parseStatus(url.searchParams.get('status')),
      limit: parseLimit(url.searchParams.get('limit')),
      cursor: url.searchParams.get('cursor') ?? undefined,
    });
    return Response.json(page);
  } catch (err) {
    return errorResponse(err);
  }
}
