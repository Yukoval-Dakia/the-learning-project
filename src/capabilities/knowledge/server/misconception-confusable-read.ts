// YUK-533 (ADR-0036 RT1 consumer) — confusable_with read model. Assembles the set
// of CONFUSABLE KC PAIRS the downstream contrast-question supply consumes.
//
// A `confusable_with` misconception_edge is SYMMETRIC and POLYMORPHIC: it always
// originates at a misconception (from_kind='misconception', RT1 invariant) and
// points at EITHER another misconception OR a KC (to_kind ∈ misconception|knowledge).
// To turn an edge into a contrast pair of UNDERLYING knowledge points we resolve each
// endpoint to its KC(s):
//   - the misconception endpoint(s) → underlying KC via the `caused_by` edge
//     (the same heterogeneous edge loadConfirmed joins in misconception-read.ts),
//   - the knowledge endpoint → already a KC (used directly).
// The two resolved KC sets are crossed into pairs (self-pairs dropped), deduped on a
// canonical sorted pair key so A↔B and B↔A collapse to ONE pair (mirrors the edge's
// own canonical ordering in misconception-edges.ts createMisconceptionEdge).
//
// RED LINES (mirror misconception-read.ts loadConfirmed):
//   - ⑥ anti-guilt: the raw edge `weight` is read LOCALLY to derive a QUALITATIVE
//     confidence band (confBand) and then DROPPED — raw weight / confidence /
//     predicted_p NEVER serialize. The conf-strip test pins both the keys and the
//     seeded numbers off the wire.
//   - ND-5 / ADR-0035 SOFT track: this edge's weight is CONFIDENCE salience only.
//     The band is a display/priority hint; it NEVER feeds θ̂/p(L)/FSRS/difficulty/
//     mastery. The contrast question generated downstream takes an INDEPENDENT
//     b-anchor (ItemPriorTask), never inheriting this edge's confidence (三轴正交).
//   - PURE READ: this module writes nothing. Day-one EMPTY (no live producer of
//     confusable_with edges) — honest empty, NEVER zero-filled.
//
// Day-one this read is genuinely EMPTY: no live writer mints confusable_with edges
// yet, so a fresh install returns []. The feature is dark behind CONFUSABLE_CONTRAST_
// ENABLED (gated at the discovery layer, src/server/question-supply/confusable-
// contrast-discovery.ts) — this reader stays flag-agnostic (a pure read model, like
// misconception-read.ts whose gating lives in the writer/promote layer).

import type { Db } from '@/db/client';
import { misconception_edge } from '@/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';

/** Qualitative confidence band — the ONLY confidence signal that crosses the wire. */
export type ConfusableConfBand = '高' | '中' | '低';

// Owner-prior conf-band cut points over the [0,1] CONFIDENCE-salience edge weight.
// MIRRORS misconception-read.ts confBand (CONF_LOW_HI / CONF_MID_HI) verbatim — kept
// as a local copy so this reader is self-contained (the sibling cut points are module-
// private). Display/priority-only, owner-tunable (NOT an n=1 calibration red line).
const CONF_LOW_HI = 0.34;
const CONF_MID_HI = 0.67;

function confBand(weight: number): ConfusableConfBand {
  if (weight < CONF_LOW_HI) return '低';
  if (weight < CONF_MID_HI) return '中';
  return '高';
}

// '高' > '中' > '低' rank — when several edges/pairs resolve to the SAME KC pair we
// keep the STRONGEST band (the raw weights are compared locally then dropped — ⑥).
const BAND_RANK: Record<ConfusableConfBand, number> = { 低: 0, 中: 1, 高: 2 };

// Defensive scan cap on the live confusable_with edge set. Day-one EMPTY + single-user,
// so this is degenerate-defense, NOT a business cap (mirrors misconception-read's
// CONFIRMED_CAP). Owner-tunable; raise if the confusable mesh ever legitimately grows.
const CONFUSABLE_EDGE_CAP = 500;

/**
 * One confusable contrast pair = two UNDERLYING KCs the learner repeatedly confuses.
 * Raw weight / confidence are deliberately ABSENT — only the qualitative `conf` band.
 */
export interface ConfusablePair {
  /** Canonical pair key (sorted KC ids joined) — symmetric dedup + fingerprint stability. */
  pairKey: string;
  /** The two underlying KC ids in canonical sorted order (a < b). */
  knowledgeIds: [string, string];
  /** Qualitative confidence band — raw edge weight read LOCALLY then DROPPED (⑥). */
  conf: ConfusableConfBand;
}

/**
 * Batch-resolve misconception ids → their underlying KC(s) via live `caused_by` edges
 * (from_kind='misconception', to_kind='knowledge', archived_at IS NULL). A misconception
 * MAY caused_by multiple KCs (returns all). Reuses the SAME edge loadConfirmed reads.
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
 * loadConfusablePairs — the live `confusable_with` mesh resolved into canonical, deduped
 * KC contrast pairs. Returns [] when no confusable edges exist (honest empty). PURE READ.
 */
export async function loadConfusablePairs(db: Db): Promise<ConfusablePair[]> {
  const edges = await db
    .select({
      from_id: misconception_edge.from_id,
      to_kind: misconception_edge.to_kind,
      to_id: misconception_edge.to_id,
      // weight read LOCALLY for confBand only — NEVER carried onto a ConfusablePair (⑥).
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
  // [no silent caps] — the degenerate-defense cap silently truncates the mesh once hit;
  // surface it (day-one EMPTY keeps this cold, but a legitimately-grown mesh must not drop
  // confusable pairs unnoticed). Raise CONFUSABLE_EDGE_CAP if this ever fires in practice.
  if (edges.length === CONFUSABLE_EDGE_CAP) {
    console.warn(
      `[confusable-read] loadConfusablePairs hit CONFUSABLE_EDGE_CAP=${CONFUSABLE_EDGE_CAP}; confusable_with edges beyond the cap were truncated (pairs may be incomplete).`,
    );
  }
  if (edges.length === 0) return [];

  // Misconception ids needing KC resolution: every from_id (always a misconception) plus
  // every misconception-kind to_id. knowledge-kind to_ids are KCs already.
  const miscIds = new Set<string>();
  for (const e of edges) {
    miscIds.add(e.from_id);
    if (e.to_kind === 'misconception') miscIds.add(e.to_id);
  }
  const kcsByMisc = await resolveMisconceptionKcs(db, [...miscIds]);

  // Accumulate the STRONGEST raw weight per canonical pair key (weights stay LOCAL —
  // the band is derived once at the end, the raw numbers never escape this function).
  const bestWeightByPair = new Map<string, { a: string; b: string; weight: number }>();
  for (const e of edges) {
    const leftKcs = kcsByMisc.get(e.from_id) ?? [];
    // Resolve the RIGHT endpoint to its underlying KC(s) by to_kind (no nested ternary):
    let rightKcs: string[];
    if (e.to_kind === 'knowledge') {
      rightKcs = [e.to_id]; // knowledge endpoint is already a KC.
    } else if (e.to_kind === 'misconception') {
      rightKcs = kcsByMisc.get(e.to_id) ?? []; // resolve the misconception → its KC(s).
    } else {
      rightKcs = []; // event endpoint (invalid topology for confusable_with) → no pair.
    }
    const w = e.weight ?? 1;
    for (const a of leftKcs) {
      for (const b of rightKcs) {
        if (a === b) continue; // a misconception confusable with one resolving to the same KC → no pair.
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
