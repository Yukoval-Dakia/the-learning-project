// Phase 1c.1 Step 9.C — `/api/knowledge/proposals` rewritten over the event stream.
//
// Pre-Step-9 the route SELECTed `dreaming_proposal` rows where kind='knowledge'.
// Post-Step-9 the legacy table is gone; propose events live as
// `event(action='propose', subject_kind='knowledge')` (Lane B ProposeKnowledge)
// plus experimental knowledge_<mutation> namespace events.
//
// Status mapping (event → legacy):
//   - 'pending'   ⇔ event with no rate=accept|dismiss in the chain (outcome='partial')
//   - 'accepted'  ⇔ rate event with rating='accept' chained via caused_by_event_id
//   - 'dismissed' ⇔ rate event with rating='dismiss' chained
//   - 'stale'     ⇔ rate event with rating='rollback' chained (rare)
//
// Wire contract preserved: { rows: [{ id, kind, payload, reasoning, status,
// proposed_at, decided_at }] }. id is the propose event id (opaque to clients).

import { and, desc, eq, inArray, isNotNull, or } from 'drizzle-orm';

import { db } from '@/db/client';
import { event } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

type LegacyStatus = 'pending' | 'accepted' | 'dismissed' | 'stale';

function isExperimentalKnowledgeMutation(action: string): boolean {
  return action.startsWith('experimental:knowledge_');
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const status = (url.searchParams.get('status') ?? 'pending') as LegacyStatus;

    // 1. Pull all propose-knowledge events (both Lane B ProposeKnowledge AND
    //    experimental:knowledge_<mutation> namespace). Both share
    //    subject_kind='knowledge', differ on action.
    const proposeRows = await db
      .select()
      .from(event)
      .where(
        or(
          and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge')),
          // experimental:knowledge_<mutation> uses subject_kind='knowledge' too
          // but action is the namespaced string. Filter at the JS layer to keep
          // the SQL simple — propose events are bounded by the dreaming cadence.
          eq(event.subject_kind, 'knowledge'),
        ),
      )
      .orderBy(desc(event.created_at));

    const proposeFiltered = proposeRows.filter(
      (r) => r.action === 'propose' || isExperimentalKnowledgeMutation(r.action),
    );

    if (proposeFiltered.length === 0) return Response.json({ rows: [] });

    // 2. Find rate events chained to these propose events (caused_by_event_id =
    //    propose event id). One propose may have multiple rate events; take the
    //    latest.
    const proposeIds = proposeFiltered.map((p) => p.id);
    const rateRows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'rate'),
          eq(event.subject_kind, 'event'),
          inArray(event.caused_by_event_id, proposeIds),
          isNotNull(event.caused_by_event_id),
        ),
      )
      .orderBy(desc(event.created_at));

    const latestRateByPropose = new Map<string, (typeof rateRows)[number]>();
    for (const r of rateRows) {
      const key = r.caused_by_event_id as string;
      if (!latestRateByPropose.has(key)) latestRateByPropose.set(key, r);
    }

    function statusForPropose(proposeId: string): LegacyStatus {
      const rate = latestRateByPropose.get(proposeId);
      if (!rate) return 'pending';
      const ratePayload = rate.payload as { rating?: string };
      switch (ratePayload.rating) {
        case 'accept':
          return 'accepted';
        case 'dismiss':
          return 'dismissed';
        case 'rollback':
          return 'stale';
        default:
          return 'pending';
      }
    }

    // 3. Project to legacy proposal-shape JSON. For Lane B ProposeKnowledge the
    //    payload is { name, parent_id, reasoning } — map to legacy
    //    { mutation: 'propose_new', name, parent_id } form so existing UI
    //    callers see the same shape.
    const rows = proposeFiltered
      .map((p) => {
        const rate = latestRateByPropose.get(p.id);
        const decided_at = rate?.created_at ?? null;
        const s = statusForPropose(p.id);
        if (s !== status) return null;

        const payload = p.payload as Record<string, unknown>;
        let legacyPayload: Record<string, unknown>;
        let reasoning: string;
        if (p.action === 'propose') {
          // Lane B ProposeKnowledge — { name, parent_id, reasoning }
          legacyPayload = {
            mutation: 'propose_new',
            name: payload.name,
            parent_id: payload.parent_id,
          };
          reasoning = String(payload.reasoning ?? '');
        } else {
          // experimental:knowledge_<mutation> — payload is the mutation body
          // verbatim; reasoning lives on a top-level field by convention.
          const { reasoning: r, ...rest } = payload as { reasoning?: string };
          legacyPayload = { mutation: p.action.replace(/^experimental:knowledge_/, ''), ...rest };
          reasoning = String(r ?? '');
        }

        return {
          id: p.id,
          kind: 'knowledge',
          payload: legacyPayload,
          reasoning,
          status: s,
          proposed_at: p.created_at,
          decided_at,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
