// P5.6 / YUK-178 (call-site 13, §5.2, SK-7) — chip-accept KPI reader.
//
// The "用户接受 AI 建议" chip metric is an EVENT-TABLE reader (no materialized
// `chip_accept_signals` table — YAGNI / anti-overengineering, SK-7). It
// aggregates `action='accept_suggestion'` events (the AcceptSuggestionChip event
// the new POST .../accept-chip endpoint writes) GROUP BY
// payload->>'suggestion_kind', and excludes `corrective` from the acceptance
// metric (LD-1: a corrective accept is still a recorded event but is NOT a KPI
// signal). The single rule across both faces of the discriminator is:
// suggestion_kind === 'corrective' ⇒ no KPI credit (ND-SK-4).

import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

type DbLike = Db | Tx;

export interface ChipAcceptCount {
  // 'proactive' | 'corrective' (the raw discriminator off the event payload).
  suggestion_kind: string;
  count: number;
}

export interface ChipAcceptKpi {
  // Per-kind chip-accept counts (corrective included here for observability).
  by_kind: ChipAcceptCount[];
  // The headline "用户接受 AI 建议" count — proactive chip-accepts only
  // (corrective excluded per the §5.2 filter / LD-1).
  proactive_accept_count: number;
}

/**
 * Aggregate `accept_suggestion` (AcceptSuggestionChip) events by
 * `suggestion_kind`. `proactive_accept_count` is the acceptance metric and
 * EXCLUDES `corrective` (WHERE payload->>'suggestion_kind' <> 'corrective',
 * §5.2 / SK-7). `by_kind` keeps every kind for observability — only the headline
 * count is filtered, so a corrective chip-accept is auditable but uncounted.
 */
export async function getChipAcceptKpi(db: DbLike): Promise<ChipAcceptKpi> {
  const rows = await db
    .select({
      suggestion_kind: sql<string>`${event.payload}->>'suggestion_kind'`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(event)
    .where(eq(event.action, 'accept_suggestion'))
    .groupBy(sql`${event.payload}->>'suggestion_kind'`);

  const byKind: ChipAcceptCount[] = rows.map((row) => ({
    suggestion_kind: row.suggestion_kind ?? 'proactive',
    count: Number(row.count ?? 0),
  }));

  const proactiveAcceptCount = byKind
    .filter((row) => row.suggestion_kind !== 'corrective')
    .reduce((sum, row) => sum + row.count, 0);

  return { by_kind: byKind, proactive_accept_count: proactiveAcceptCount };
}
