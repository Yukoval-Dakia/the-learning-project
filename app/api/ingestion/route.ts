import { z } from 'zod';

import { IngestionEntrypoint } from '@/core/schema/business';
import { db } from '@/db/client';
import { event, learning_session, question_block, source_asset } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { Ingestion } from '@/server/session';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

/**
 * GET /api/ingestion?limit=20 —— recent ingestion sessions for the OC-5 review
 * surface (YUK-164 #2). The AutoEnrolledPanel sits on /record with no session
 * context, so it needs a list to pick which past ingestion to inspect.
 *
 * Returns newest-first (created_at desc), capped at `limit` (clamped 1..100;
 * keyset/cursor pagination is overkill for a single-user low-volume tool — add
 * `before=<iso>` later if volume ever grows). Filters to type='ingestion'
 * sessions that have ≥1 block (a freshly-extracted session with 0 observations is
 * still a valid pick — we do NOT filter on observation_count, only block_count>0,
 * so the observe-empty state stays visible).
 *
 * Per-session counts (one grouped query each; cheap, always returned — no query
 * param gate):
 *   - observation_count   = # auto_enroll_observed events on this session's blocks
 *                           (canonical query: event.action='experimental:auto_enroll_observed',
 *                            NOT generated_by — once the flag is ON the enroll events
 *                            also carry generated_by='workflow_judge').
 *   - auto_enrolled_count = # question_block rows status='auto_enrolled' (non-zero
 *                           only once WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED=ON; tells
 *                           the panel how many rows have an actionable revert).
 *   - block_count         = total blocks (context: "3 of 5 observed").
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = clampLimit(url.searchParams.get('limit'));

    // 1) latest ingestion sessions that have ≥1 block (newest first, capped at
    //    limit). The "has a block" predicate is pushed into SQL as an EXISTS
    //    subquery BEFORE orderBy+limit so block-less sessions never consume a
    //    limit slot and crowd out an older-but-valid session (codex/CodeRabbit:
    //    in-memory post-filter could drop valid rows). NB: no learning_session
    //    .block_count column exists — the predicate is an EXISTS over question_block.
    const sessions = await db
      .select({
        id: learning_session.id,
        entrypoint: learning_session.entrypoint,
        status: learning_session.status,
        source_asset_ids: learning_session.source_asset_ids,
        created_at: learning_session.created_at,
      })
      .from(learning_session)
      .where(
        and(
          eq(learning_session.type, 'ingestion'),
          sql`exists (select 1 from ${question_block} where ${question_block.ingestion_session_id} = ${learning_session.id})`,
        ),
      )
      .orderBy(desc(learning_session.created_at))
      .limit(limit);

    const sessionIds = sessions.map((s) => s.id);
    if (sessionIds.length === 0) {
      return Response.json({ rows: [] });
    }

    // 2) blocks grouped by session: total count + auto_enrolled count.
    const blockAgg = await db
      .select({
        sid: question_block.ingestion_session_id,
        total: sql<number>`count(*)::int`,
        enrolled: sql<number>`count(*) filter (where ${question_block.status} = 'auto_enrolled')::int`,
      })
      .from(question_block)
      .where(inArray(question_block.ingestion_session_id, sessionIds))
      .groupBy(question_block.ingestion_session_id);

    // 3) observation events grouped by session.
    //    event.subject_id for observe events is the BLOCK id (auto-enroll.ts:295
    //    subject_id: block.id), NOT the session id. The payload carries
    //    ingestion_session_id, but joining on payload JSON is ugly — cleaner to
    //    join observed events → their block → session.
    const obsAgg = await db
      .select({
        sid: question_block.ingestion_session_id,
        obs: sql<number>`count(*)::int`,
      })
      .from(event)
      .innerJoin(question_block, eq(event.subject_id, question_block.id))
      .where(
        and(
          eq(event.action, 'experimental:auto_enroll_observed'),
          eq(event.subject_kind, 'question_block'),
          inArray(question_block.ingestion_session_id, sessionIds),
        ),
      )
      .groupBy(question_block.ingestion_session_id);

    const blockBySid = new Map(blockAgg.map((b) => [b.sid, b]));
    const obsBySid = new Map(obsAgg.map((o) => [o.sid, o.obs]));

    // The "has ≥1 block" filter is already applied in SQL (EXISTS in step 1), so
    // every session here has blocks — no in-memory block_count>0 post-filter (which
    // would drop valid older rows already squeezed out of the limit). We do NOT
    // filter on observation_count: a freshly-extracted session with 0 observations
    // is a valid pick whose observe-empty state we want to surface.
    const rows = sessions.map((s) => {
      const agg = blockBySid.get(s.id);
      return {
        id: s.id,
        entrypoint: s.entrypoint,
        status: s.status,
        source_asset_ids: s.source_asset_ids,
        observation_count: Number(obsBySid.get(s.id) ?? 0),
        auto_enrolled_count: Number(agg?.enrolled ?? 0),
        block_count: Number(agg?.total ?? 0),
        // unix sec — mirror blocks/route.ts:96 convention.
        created_at: Math.floor(s.created_at.getTime() / 1000),
      };
    });

    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}

function clampLimit(raw: string | null): number {
  const parsed = raw == null ? DEFAULT_LIMIT : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
}

const Body = z.object({
  entrypoint: IngestionEntrypoint,
  asset_ids: z.array(z.string().min(1)).min(1).max(5),
});

/**
 * POST /api/ingestion —— 创建 ingestion session（status='uploaded'）。
 *
 * Sub 0c 把抽取从这里**剥离**：本 route 只创建会话；客户端拿 session.id 后调
 * POST /api/ingestion/[id]/extract 异步触发抽取，开 SSE 听进度。
 *
 * 旧 sync cascade 行为（Step 0 之前）已删除：
 *   - 不再调 runOCRCascade
 *   - 不再写 question_block 行
 *   - 不再返回 blocks
 *   - error_message 不再写 tier_log JSON（tier 信息现在通过 job_events + SSE 推）
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const body = parsed.data;

    // Validate asset_ids exist
    const foundRows = await db
      .select({ id: source_asset.id })
      .from(source_asset)
      .where(inArray(source_asset.id, body.asset_ids));
    const foundIds = new Set(foundRows.map((r) => r.id));
    const missing = body.asset_ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new ApiError('validation_error', `unknown asset_ids: ${missing.join(', ')}`, 400);
    }

    // Ingestion.initiateUpload — single owner for learning_session(type='ingestion') writes
    const { sessionId, sourceDocumentId } = await Ingestion.initiateUpload(db, {
      assetIds: body.asset_ids,
      entrypoint: body.entrypoint,
    });

    return Response.json({
      session: {
        id: sessionId,
        source_document_id: sourceDocumentId,
        status: 'uploaded',
        source_asset_ids: body.asset_ids,
        entrypoint: body.entrypoint,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
