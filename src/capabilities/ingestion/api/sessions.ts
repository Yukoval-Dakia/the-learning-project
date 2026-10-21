import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  markSessionPackageFailed,
  materializeSourcePackage,
} from '@/capabilities/ingestion/server/source-package';
import { db } from '@/db/client';
import { event, learning_session, question_block, source_asset } from '@/db/schema';
import {
  ApiError,
  canonicalResourceResponse,
  collectionPayload,
  deprecatedRouteResponse,
  errorResponse,
} from '@/kernel/http';
import { Ingestion } from '@/server/session';
import { resolveSelectableSubjectId } from '@/subjects/profile';
import { CreateIngestionSessionBody } from './contracts';

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

/**
 * Lists recent ingestion sessions for the review surface, newest first with a
 * keyset cursor. Only sessions with at least one block are included; sessions with
 * zero observations stay visible so the observe-empty state is not hidden.
 *
 * Counts: observed events (by action, not generated_by), auto-enrolled blocks, and
 * total blocks.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = clampLimit(url.searchParams.get('limit'));
    const cursor = decodeCursor(url.searchParams.get('cursor'));

    // The block predicate runs in SQL before orderBy+limit so block-less sessions
    // never consume a limit slot and crowd out older valid ones.
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
          cursor
            ? or(
                lt(learning_session.created_at, cursor.createdAt),
                and(
                  eq(learning_session.created_at, cursor.createdAt),
                  lt(learning_session.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(learning_session.created_at), desc(learning_session.id))
      .limit(limit + 1);

    const hasMore = sessions.length > limit;
    const pageSessions = hasMore ? sessions.slice(0, limit) : sessions;
    const lastSession = pageSessions.at(-1);
    const nextCursor =
      hasMore && lastSession
        ? encodeCursor({ createdAt: lastSession.created_at, id: lastSession.id })
        : null;

    const sessionIds = pageSessions.map((s) => s.id);
    if (sessionIds.length === 0) {
      return Response.json(
        collectionPayload([], { limit, next_cursor: null }, { rows: [], next_cursor: null }),
      );
    }

    // Blocks grouped by session: total and auto-enrolled counts.
    const blockAgg = await db
      .select({
        sid: question_block.ingestion_session_id,
        total: sql<number>`count(*)::int`,
        enrolled: sql<number>`count(*) filter (where ${question_block.status} = 'auto_enrolled')::int`,
      })
      .from(question_block)
      .where(inArray(question_block.ingestion_session_id, sessionIds))
      .groupBy(question_block.ingestion_session_id);

    // Observation events are keyed by block id, so join through the block.
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

    // SQL already enforced at least one block. Do not post-filter, and keep
    // zero-observation sessions visible.
    const rows = pageSessions.map((s) => {
      const agg = blockBySid.get(s.id);
      return {
        id: s.id,
        entrypoint: s.entrypoint,
        status: s.status,
        source_asset_ids: s.source_asset_ids,
        observation_count: Number(obsBySid.get(s.id) ?? 0),
        auto_enrolled_count: Number(agg?.enrolled ?? 0),
        block_count: Number(agg?.total ?? 0),
        // Unix seconds, matching the blocks route.
        created_at: Math.floor(s.created_at.getTime() / 1000),
      };
    });

    return Response.json(
      collectionPayload(
        rows,
        { limit, next_cursor: nextCursor },
        { rows, next_cursor: nextCursor },
      ),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

interface SessionCursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(cursor: SessionCursor): string {
  return Buffer.from(
    JSON.stringify({ created_at: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString('base64url');
}

function decodeCursor(raw: string | null): SessionCursor | null {
  if (raw == null) return null;

  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      created_at?: unknown;
      id?: unknown;
    };
    if (typeof parsed.created_at !== 'string' || typeof parsed.id !== 'string') throw new Error();
    const createdAt = new Date(parsed.created_at);
    if (Number.isNaN(createdAt.getTime()) || parsed.id.length === 0) throw new Error();
    return { createdAt, id: parsed.id };
  } catch {
    throw new ApiError('invalid_cursor', 'cursor is invalid', 400);
  }
}

function clampLimit(raw: string | null): number {
  const parsed = raw == null ? DEFAULT_LIMIT : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
}

// The asset cap is the PDF page cap, imported from the single source so the two
// cannot drift. The pipeline is length-driven, so raising the ceiling is safe.
/**
 * Creates an ingestion session in 'uploaded'; extraction is a separate async call
 * observed over SSE. This route writes no blocks and returns no extraction output.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = CreateIngestionSessionBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const body = parsed.data;

    // Optional subject, validated before any write. Null means unknown and is not
    // persisted; a value must resolve through the selectable registry or 400.
    const requestedSubjectId = body.subject_id ?? null;
    const canonicalSubjectId =
      requestedSubjectId === null ? null : resolveSelectableSubjectId(requestedSubjectId);
    if (requestedSubjectId !== null && canonicalSubjectId === null) {
      throw new ApiError(
        'validation_error',
        `subject_id: unknown or not currently selectable subject '${requestedSubjectId}'`,
        400,
      );
    }

    // Validate that asset ids exist.
    const foundRows = await db
      .select({ id: source_asset.id })
      .from(source_asset)
      .where(inArray(source_asset.id, body.asset_ids));
    const foundIds = new Set(foundRows.map((r) => r.id));
    const missing = body.asset_ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new ApiError('validation_error', `unknown asset_ids: ${missing.join(', ')}`, 400);
    }

    // Single owner for ingestion session writes.
    const { sessionId, sourceDocumentId } = await Ingestion.initiateUpload(db, {
      assetIds: body.asset_ids,
      entrypoint: body.entrypoint,
      // Validated subject (null persists as absent) and consent (absent = allow).
      learnerSelectedSubjectId: canonicalSubjectId,
      derivationPolicy: body.derivation_policy ?? null,
    });

    // Materialize the source package on the document. It is read back through the
    // session, not the response body.
    try {
      await materializeSourcePackage(db, sourceDocumentId);
    } catch (err) {
      // The session row exists, so mark it failed rather than orphaning it.
      await markSessionPackageFailed(db, sessionId, err);
      throw err;
    }

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

/** Canonical POST /api/ingestion-sessions resource contract. */
export async function createIngestionSessionResource(req: Request): Promise<Response> {
  return canonicalResourceResponse(await POST(req), {
    outcome: 'created',
    location: (body) => {
      const sessionId = (body as { session: { id: string } }).session.id;
      return `/api/ingestion-sessions/${encodeURIComponent(sessionId)}`;
    },
  });
}

export async function legacyListIngestionSessions(req: Request): Promise<Response> {
  return deprecatedRouteResponse(await GET(req), '/api/ingestion-sessions');
}

export async function legacyCreateIngestionSession(req: Request): Promise<Response> {
  return deprecatedRouteResponse(await POST(req), '/api/ingestion-sessions');
}
