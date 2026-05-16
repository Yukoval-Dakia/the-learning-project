// Phase 1c.2 — accept knowledge-edge proposals into knowledge_edge.
//
// Pre-1c.2 the UI tracked accept/reverse/change_type/dismiss decisions in local
// React state only — the proposal stream was effectively dry-run. This route
// closes that loop: a single POST writes a rate event (ADR-0011 RateKnowledgeEdge),
// and for accept-class decisions also inserts the actual knowledge_edge row +
// a chained generate event (ADR-0011 GenerateKnowledgeEdge) inside one txn.
//
// POST /api/knowledge/edges/proposals/[id]
//   body: { decision: 'accept' | 'reverse' | 'change_type' | 'dismiss',
//           new_relation_type?: string,    // required when decision='change_type'
//           user_note?: string }
//   → 200 { rate_event_id, generate_event_id|null, edge_id|null }
//   → 200 { …, idempotent: true } when re-submitting the same decision
//   → 400 validation error (bad decision, missing new_relation_type, etc.)
//   → 404 propose event not found
//   → 409 proposal already decided differently / edge collides with existing row
//
// `id` is the propose event id (the row in `event` with action='propose' and
// subject_kind='knowledge_edge'). Chain: rate.caused_by = propose.id,
// generate.caused_by = propose.id, generate.payload.propose_event_id = propose.id.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { RelationTypeSchema } from '@/core/schema/event/blocks';
import { db } from '@/db/client';
import { event, knowledge, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { inArray } from 'drizzle-orm';

export const runtime = 'nodejs';

const DecisionBody = z.object({
  decision: z.enum(['accept', 'reverse', 'change_type', 'dismiss']),
  new_relation_type: RelationTypeSchema.optional(),
  user_note: z.string().max(2000).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id: proposeEventId } = await params;
    const raw = await req.json().catch(() => null);
    const parsed = DecisionBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { decision, new_relation_type, user_note } = parsed.data;

    if (decision === 'change_type' && !new_relation_type) {
      throw new ApiError('validation_error', 'change_type requires new_relation_type', 400);
    }

    // 1) Load + validate the propose event.
    const proposeRows = await db.select().from(event).where(eq(event.id, proposeEventId)).limit(1);
    const proposeRow = proposeRows[0];
    if (!proposeRow) {
      throw new ApiError('not_found', `propose event ${proposeEventId} not found`, 404);
    }
    if (proposeRow.action !== 'propose' || proposeRow.subject_kind !== 'knowledge_edge') {
      throw new ApiError(
        'validation_error',
        `event ${proposeEventId} is not a knowledge_edge proposal (action=${proposeRow.action}, subject_kind=${proposeRow.subject_kind})`,
        400,
      );
    }
    const proposePayload = proposeRow.payload as {
      from_knowledge_id: string;
      to_knowledge_id: string;
      relation_type: string;
      weight?: number;
      reasoning?: string;
    };
    const proposeSubjectId = proposeRow.subject_id;

    // 2) Idempotency: a prior rate event chained to this propose locks the
    //    decision. Re-submitting the same decision returns the existing ids;
    //    submitting a different decision is a 409 conflict.
    const existingRateRows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'rate'),
          eq(event.subject_kind, 'knowledge_edge'),
          eq(event.caused_by_event_id, proposeEventId),
        ),
      )
      .limit(1);
    const existingRate = existingRateRows[0];
    if (existingRate) {
      const ratePayload = existingRate.payload as { rating?: string };
      if (ratePayload.rating !== decision) {
        throw new ApiError(
          'conflict',
          `proposal ${proposeEventId} already decided as ${ratePayload.rating}`,
          409,
        );
      }
      const existingGenRows = await db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, 'generate'),
            eq(event.subject_kind, 'knowledge_edge'),
            eq(event.caused_by_event_id, proposeEventId),
          ),
        )
        .limit(1);
      const gen = existingGenRows[0];
      return Response.json({
        rate_event_id: existingRate.id,
        generate_event_id: gen?.id ?? null,
        edge_id: gen?.subject_id ?? null,
        idempotent: true,
      });
    }

    const now = new Date();
    const rateEventId = createId();

    // 3) `dismiss` — no edge, just record the rate.
    if (decision === 'dismiss') {
      await writeEvent(db, {
        id: rateEventId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'knowledge_edge',
        subject_id: proposeSubjectId,
        outcome: 'success',
        payload: {
          rating: 'dismiss',
          ...(user_note ? { user_note } : {}),
        },
        caused_by_event_id: proposeEventId,
        created_at: now,
      });
      return Response.json({
        rate_event_id: rateEventId,
        generate_event_id: null,
        edge_id: null,
      });
    }

    // 4) `accept` / `reverse` / `change_type` — derive the final edge shape from
    //    the proposal + decision, FK-check, then rate + edge + generate atomically.
    const fromId =
      decision === 'reverse' ? proposePayload.to_knowledge_id : proposePayload.from_knowledge_id;
    const toId =
      decision === 'reverse' ? proposePayload.from_knowledge_id : proposePayload.to_knowledge_id;
    const relationType =
      decision === 'change_type' ? (new_relation_type as string) : proposePayload.relation_type;
    const weight = proposePayload.weight ?? 1;

    // FK existence + un-archived check on both endpoints (domain-friendly 404
    // ahead of the raw FK constraint error).
    const endpointIds = Array.from(new Set([fromId, toId]));
    const found = await db
      .select({ id: knowledge.id, archived_at: knowledge.archived_at })
      .from(knowledge)
      .where(inArray(knowledge.id, endpointIds));
    const foundActive = new Set(found.filter((r) => r.archived_at === null).map((r) => r.id));
    const missing = endpointIds.filter((id) => !foundActive.has(id));
    if (missing.length > 0) {
      throw new ApiError(
        'not_found',
        `unknown or archived knowledge_id(s): ${missing.join(', ')}`,
        404,
      );
    }

    const edgeId = createId();
    const generateEventId = createId();

    try {
      await db.transaction(async (tx) => {
        await writeEvent(tx, {
          id: rateEventId,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'rate',
          subject_kind: 'knowledge_edge',
          subject_id: proposeSubjectId,
          outcome: 'success',
          payload: {
            rating: decision,
            ...(decision === 'reverse' ? { new_direction_reversed: true } : {}),
            ...(decision === 'change_type' ? { new_relation_type: relationType } : {}),
            ...(user_note ? { user_note } : {}),
          },
          caused_by_event_id: proposeEventId,
          created_at: now,
        });

        await tx.insert(knowledge_edge).values({
          id: edgeId,
          from_knowledge_id: fromId,
          to_knowledge_id: toId,
          relation_type: relationType,
          weight,
          created_by: {
            actor_kind: 'user',
            actor_ref: 'self',
            propose_event_id: proposeEventId,
          } as never,
          reasoning: proposePayload.reasoning ?? null,
          created_at: now,
        });

        await writeEvent(tx, {
          id: generateEventId,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'generate',
          subject_kind: 'knowledge_edge',
          subject_id: edgeId,
          outcome: 'success',
          payload: {
            from_knowledge_id: fromId,
            to_knowledge_id: toId,
            relation_type: relationType,
            weight,
            reasoning: proposePayload.reasoning ?? '',
            propose_event_id: proposeEventId,
          },
          caused_by_event_id: proposeEventId,
          created_at: now,
        });
      });
    } catch (err) {
      const pgCode =
        (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
      if (pgCode === '23505') {
        throw new ApiError(
          'conflict',
          `edge already exists: ${fromId} --${relationType}--> ${toId}`,
          409,
        );
      }
      throw err;
    }

    return Response.json({
      rate_event_id: rateEventId,
      generate_event_id: generateEventId,
      edge_id: edgeId,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
