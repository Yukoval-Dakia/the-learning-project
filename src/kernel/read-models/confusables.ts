// Confusable KC pairs for contrast-question supply.
//
// A confusable_with edge starts at a misconception and points at another
// misconception or a KC. Each endpoint resolves to its underlying KC(s) via
// caused_by; the sets are crossed, self-pairs dropped, and canonical sorted keys
// dedupe A<->B with B<->A.
//
// Raw edge weight stays local and becomes a qualitative band; it never serializes
// and never feeds theta/mastery/difficulty. Pure read: no writer mints these edges
// yet, so a fresh install returns [] honestly.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { misconception_edge } from '@/db/schema';

/** Qualitative confidence band — the ONLY confidence signal that crosses the wire. */
export type ConfusableConfBand = '高' | '中' | '低';

// Mirrors misconception-read's confBand cut points; display/priority only.
const CONF_LOW_HI = 0.34;
const CONF_MID_HI = 0.67;

function confBand(weight: number): ConfusableConfBand {
  if (weight < CONF_LOW_HI) return '低';
  if (weight < CONF_MID_HI) return '中';
  return '高';
}

// Keep the strongest band when several edges resolve to the same KC pair.
const BAND_RANK: Record<ConfusableConfBand, number> = { 低: 0, 中: 1, 高: 2 };

// Degenerate-defense scan cap; this set is empty on day one, not a business cap.
const CONFUSABLE_EDGE_CAP = 500;

/**
 * One contrast pair of underlying KCs. Raw weight and confidence are absent; only
 * the qualitative band crosses the wire.
 */
export interface ConfusablePair {
  /** Canonical sorted pair key; symmetric dedup and fingerprint stability. */
  pairKey: string;
  /** The two KC ids in sorted order (a < b). */
  knowledgeIds: [string, string];
  /** Qualitative band; the raw weight is read locally and dropped. */
  conf: ConfusableConfBand;
}

/**
 * Resolve misconception ids to their underlying KCs via live caused_by edges. A
 * misconception may map to several KCs.
 */
async function resolveMisconceptionKcs(db: Db, miscIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (miscIds.length === 0) return out;
  const rows = await db
    .select({
      from_id: misconception_edge.from_id,
      to_id: misconception_edge.to_id,
    })
    .from(misconception_edge)
    .where(
      and(
        eq(misconception_edge.relation_type, 'caused_by'),
        eq(misconception_edge.from_kind, 'misconception'),
        eq(misconception_edge.to_kind, 'knowledge'),
        inArray(misconception_edge.from_id, miscIds),
        isNull(misconception_edge.archived_at),
      ),
    );
  for (const r of rows) {
    const list = out.get(r.from_id) ?? [];
    list.push(r.to_id);
    out.set(r.from_id, list);
  }
  return out;
}

/**
 * Live confusable_with mesh as canonical, deduped KC contrast pairs. Honest empty
 * when no edges exist; pure read.
 */
export async function loadConfusablePairs(db: Db): Promise<ConfusablePair[]> {
  const edges = await db
    .select({
      from_id: misconception_edge.from_id,
      to_kind: misconception_edge.to_kind,
      to_id: misconception_edge.to_id,
      // Local to confBand only; never carried onto a pair.
      weight: misconception_edge.weight,
    })
    .from(misconception_edge)
    .where(
      and(
        eq(misconception_edge.relation_type, 'confusable_with'),
        isNull(misconception_edge.archived_at),
      ),
    )
    .limit(CONFUSABLE_EDGE_CAP);
  // Surface truncation instead of silently dropping pairs; raise the cap if it fires.
  if (edges.length === CONFUSABLE_EDGE_CAP) {
    console.warn(
      `[confusable-read] loadConfusablePairs hit CONFUSABLE_EDGE_CAP=${CONFUSABLE_EDGE_CAP}; confusable_with edges beyond the cap were truncated (pairs may be incomplete).`,
    );
  }
  if (edges.length === 0) return [];

  // Misconception ids needing resolution: every from_id, plus every
  // misconception-kind to_id. Knowledge endpoints are already KCs.
  const miscIds = new Set<string>();
  for (const e of edges) {
    miscIds.add(e.from_id);
    if (e.to_kind === 'misconception') miscIds.add(e.to_id);
  }
  const kcsByMisc = await resolveMisconceptionKcs(db, [...miscIds]);

  // Keep the strongest weight per canonical pair; raw weights stay local.
  const bestWeightByPair = new Map<string, { a: string; b: string; weight: number }>();
  for (const e of edges) {
    const leftKcs = kcsByMisc.get(e.from_id) ?? [];
    // Resolve the right endpoint by kind; an event endpoint is invalid here and
    // yields no pair.
    let rightKcs: string[];
    if (e.to_kind === 'knowledge') {
      rightKcs = [e.to_id]; // Already a KC.
    } else if (e.to_kind === 'misconception') {
      rightKcs = kcsByMisc.get(e.to_id) ?? []; // Resolve misconception -> KC(s).
    } else {
      rightKcs = []; // Event endpoint is invalid topology for confusable_with.
    }
    const w = e.weight ?? 1;
    for (const a of leftKcs) {
      for (const b of rightKcs) {
        if (a === b) continue; // A misconception resolving to the same KC yields no pair.
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const key = `${lo}|${hi}`;
        const prev = bestWeightByPair.get(key);
        if (!prev || w > prev.weight) bestWeightByPair.set(key, { a: lo, b: hi, weight: w });
      }
    }
  }

  const pairs: ConfusablePair[] = [...bestWeightByPair.entries()].map(([pairKey, v]) => ({
    pairKey,
    knowledgeIds: [v.a, v.b] as [string, string],
    conf: confBand(v.weight),
  }));
  // Deterministic order: strongest band first, then pair key (no probability on the wire).
  return pairs.sort(
    (x, y) => BAND_RANK[y.conf] - BAND_RANK[x.conf] || x.pairKey.localeCompare(y.pairKey),
  );
}
