// M4-T5 (YUK-319)：旧 app/api/proposals/route.ts 等价平移（parseStatus /
// parseLimit 照抄）+ kind query 增量（YUK-318 收口：knowledge UI 边提议从
// /api/events 裸查换源到统一收件箱）。

import { aiProposalKinds } from '@/core/schema/proposal';
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

function parseKind(value: string | null): string | undefined {
  if (value === null) return undefined;
  if ((aiProposalKinds as readonly string[]).includes(value)) return value;
  throw new ApiError('validation_error', `invalid proposal kind: ${value}`, 400);
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const kind = parseKind(url.searchParams.get('kind'));
    const page = await listProposalInboxPage(db, {
      status: parseStatus(url.searchParams.get('status')),
      limit: parseLimit(url.searchParams.get('limit')),
      cursor: url.searchParams.get('cursor') ?? undefined,
    });
    if (kind === undefined) return Response.json(page);
    // kind 过滤是路由层投影后 post-filter：inbox 读模型不感知 kind（不动
    // inbox.ts），过滤按「页内」语义作用于当页 rows——next_cursor 仍指向未
    // 过滤流的下一页。YUK-318 用例（kind=knowledge_edge&status=pending）
    // 集合小、单页即全集，不依赖跨页过滤。
    return Response.json({ ...page, rows: page.rows.filter((row) => row.kind === kind) });
  } catch (err) {
    return errorResponse(err);
  }
}
