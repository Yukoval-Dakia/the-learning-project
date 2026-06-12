// M4-T5 (YUK-319)：旧 app/api/proposals/route.ts 等价平移（parseStatus /
// parseLimit 照抄）+ kind query 增量（YUK-318 收口：knowledge UI 边提议从
// /api/events 裸查换源到统一收件箱）。kind 过滤在 inbox 读模型投影层执行
// （与 status 同位），跨页分页语义正确（codex P2 / coderabbit major review fix）。

import { type AiProposalPayloadT, aiProposalKinds } from '@/core/schema/proposal';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { type ProposalStatus, listProposalInboxPage } from '@/server/proposals/inbox';

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

function parseKind(value: string | null): AiProposalPayloadT['kind'] | undefined {
  if (value === null) return undefined;
  if ((aiProposalKinds as readonly string[]).includes(value)) {
    return value as AiProposalPayloadT['kind'];
  }
  throw new ApiError('validation_error', `invalid proposal kind: ${value}`, 400);
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const page = await listProposalInboxPage(db, {
      status: parseStatus(url.searchParams.get('status')),
      kind: parseKind(url.searchParams.get('kind')),
      limit: parseLimit(url.searchParams.get('limit')),
      cursor: url.searchParams.get('cursor') ?? undefined,
    });
    return Response.json(page);
  } catch (err) {
    return errorResponse(err);
  }
}
