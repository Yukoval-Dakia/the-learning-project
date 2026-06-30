// YUK-531 (A5 S4 / ADR-0036 RT1) — per-KC misconception read model. Assembles the
// 「指向此点的误区」funnel for ONE KC from TWO segments:
//
//   - CONFIRMED segment (RT1 误区): live `misconception(status='active', archived_at IS
//     NULL)` rows joined to the KC via a non-archived `caused_by` misconception_edge
//     (the heterogeneous edge whose to_kind='knowledge' points at this KC). The writer
//     is PR-3, gated behind MISCONCEPTION_PROMOTE_ENABLED — so this segment is genuinely
//     EMPTY day-one (honest empty, NEVER zero-filled). Mirrors frontier-read.ts's
//     edge-join read style.
//   - CANDIDATE segment (猜想/候选): the per-KC PENDING conjecture proposals (the
//     identity-preserving substrate the promotion flow draws from). Read DIRECTLY from
//     the proposal inbox + filtered by proposed_change.knowledge_id — NOT via
//     loadPrepDeskConjectures, which caps globally at top-3 with NO knowledge_id filter
//     (a KC with a real pending conjecture could otherwise show 0). This segment carries
//     the day-one content while the confirmed segment is still empty.
//
// RED LINES (⑥ anti-guilt governance, LOAD-BEARING):
//   - Raw weight / confidence / predicted_p / baseline_p NEVER serialize. The confirmed
//     `conf` is the QUALITATIVE confBand(weight) discretization (weight read locally then
//     dropped); the candidate `conf` is the FIXED '低' — change.confidence is read
//     NOWHERE. The conf-strip test proves both the keys and the raw seeded numbers stay
//     off the wire.
//   - `seen` (recurrence COUNT, an int) IS allowed on the wire — only probabilities are
//     banned (mirrors the prep-desk recurrence_count precedent).
//   - PURE READ: this module writes nothing.
//
// See docs/design/2026-06-29-yuk-a5-knowledge-explorer-build-plan.md (S4) and screen-
// knowledge-a5.jsx (MisconceptionList / MisconceptionCard) for the PR-5 render contract.

import type { Db } from '@/db/client';
import { misconception, misconception_edge } from '@/db/schema';
import { listProposalInboxPage } from '@/server/proposals/inbox';
import { and, desc, eq, isNull } from 'drizzle-orm';

/** Qualitative confidence band — the ONLY confidence signal that crosses the wire. */
export type MisconceptionConfBand = '高' | '中' | '低';

// Owner-prior conf-band cut points over the [0,1] CONFIDENCE-salience weight. Default
// even thirds; display-only, owner-tunable (NOT an n=1 calibration red line). The SAME
// low cut doubles as the status-fading threshold (below) so there is no second magic
// number for "low-confidence ⇒ fading".
const CONF_LOW_HI = 0.34;
const CONF_MID_HI = 0.67;

function confBand(weight: number): MisconceptionConfBand {
  if (weight < CONF_LOW_HI) return '低';
  if (weight < CONF_MID_HI) return '中';
  return '高';
}

// Char cap on the candidate `label` (claim_md head). `belief` carries the full claim;
// `label` is the short, title-equivalent head. Mirrors frontier-read's reason clamp.
const CANDIDATE_LABEL_CAP = 40;

// Scan cap on the pending-conjecture window. listProposalInboxPage is recency-ordered;
// 50 comfortably covers a single KC's pending conjectures (nightly induction keeps the
// pending set small). Degenerate-defense, NOT a business cap — mirrors PREP_DESK_FETCH_LIMIT.
const CANDIDATE_SCAN_CAP = 50;

/**
 * One row in the per-KC misconception funnel. ALL confidence is qualitative — raw
 * weight / confidence / predicted_p / baseline_p are deliberately ABSENT from this type.
 */
export interface MisconceptionRow {
  id: string;
  /** 'confirmed' = RT1 误区 (live promoted); 'candidate' = 猜想/候选 (pending conjecture). */
  segment: 'confirmed' | 'candidate';
  /** Short label — confirmed←title / candidate←claim_md head. */
  label: string;
  /** The belief statement — confirmed←reasoning / candidate←full claim_md. */
  belief: string;
  /** Display projection (NOT the stored draft|active enum). 'retracted' never surfaces. */
  status: 'active' | 'fading';
  /** Provenance track — confirmed←row.source / candidate←'soft' (fixed). */
  source: 'hard' | 'soft';
  /** Qualitative confidence band — confirmed←confBand(weight) / candidate←'低' (fixed). */
  conf: MisconceptionConfBand;
  /** Recurrence COUNT (int) — allowed on the wire; only probabilities are banned. */
  seen: number;
  /** Evidence event-id back-links. */
  evidence: string[];
}

function clampHead(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** CONFIRMED segment — live `caused_by` misconception_edge → active misconception join. */
async function loadConfirmed(db: Db, kcId: string): Promise<MisconceptionRow[]> {
  const rows = await db
    .select({
      id: misconception.id,
      title: misconception.title,
      reasoning: misconception.reasoning,
      // weight read LOCALLY for confBand only — NEVER selected into the wire row (⑥).
      weight: misconception.weight,
      source: misconception.source,
      seen: misconception.seen,
      evidence: misconception.evidence,
    })
    .from(misconception_edge)
    .innerJoin(misconception, eq(misconception.id, misconception_edge.from_id))
    .where(
      and(
        eq(misconception_edge.relation_type, 'caused_by'),
        eq(misconception_edge.from_kind, 'misconception'),
        eq(misconception_edge.to_kind, 'knowledge'),
        eq(misconception_edge.to_id, kcId),
        isNull(misconception_edge.archived_at),
        eq(misconception.status, 'active'),
        isNull(misconception.archived_at),
      ),
    )
    // Most-recurrent first; id tiebreaker keeps any >cap ordering deterministic.
    .orderBy(desc(misconception.seen), desc(misconception.id));

  return rows.map((r) => {
    const band = confBand(r.weight ?? 1);
    return {
      id: r.id,
      segment: 'confirmed' as const,
      label: r.title,
      belief: r.reasoning ?? '',
      // Fading is the low-confidence (decaying-salience) display projection; reuse the
      // conf '低' cut so there is no second threshold. 'retracted' never appears here —
      // archived misconceptions/edges are filtered out by the WHERE above.
      status: band === '低' ? 'fading' : 'active',
      source: r.source === 'hard' ? 'hard' : 'soft',
      conf: band,
      seen: r.seen,
      evidence: r.evidence,
    };
  });
}

/** CANDIDATE segment — per-KC pending conjecture proposals (inbox read + KC filter). */
async function loadCandidates(db: Db, kcId: string): Promise<MisconceptionRow[]> {
  const { rows } = await listProposalInboxPage(db, {
    status: 'pending',
    kind: 'conjecture',
    limit: CANDIDATE_SCAN_CAP,
  });

  const candidates = rows.flatMap((row): MisconceptionRow[] => {
    // Narrow the discriminated union to the conjecture variant.
    if (row.payload.kind !== 'conjecture') return [];
    const change = row.payload.proposed_change;
    // Per-KC filter — the inbox window is global; keep only THIS KC's conjectures.
    if (change.knowledge_id !== kcId) return [];
    // CONF-STRIP: change.confidence / predicted_p / baseline_p_at_induction are read
    // NOWHERE here — a candidate is low-confidence by construction, so `conf` is the
    // FIXED qualitative '低' and ordering uses recurrence_count, never a probability.
    return [
      {
        id: row.id,
        segment: 'candidate',
        label: clampHead(change.claim_md, CANDIDATE_LABEL_CAP),
        belief: change.claim_md,
        // A pending conjecture is an ACTIVELY-tracked hypothesis (induced BY recurrence),
        // never "fading" — status is fixed 'active'; segment+source already tag it soft.
        status: 'active',
        source: 'soft',
        conf: '低',
        seen: change.recurrence_count,
        evidence: row.payload.evidence_refs.map((ref) => ref.id),
      },
    ];
  });

  // Most-recurrent first (recurrence_count is the only ordering signal; NOT confidence).
  return candidates.sort((a, b) => b.seen - a.seen);
}

/**
 * loadMisconceptionsForKc — the per-KC「指向此点的误区」funnel. Confirmed (RT1) rows
 * first, then candidate (conjecture) rows. Returns [] for a KC with neither (honest
 * empty — NEVER zero-filled). PURE READ.
 */
export async function loadMisconceptionsForKc(db: Db, kcId: string): Promise<MisconceptionRow[]> {
  const [confirmed, candidates] = await Promise.all([
    loadConfirmed(db, kcId),
    loadCandidates(db, kcId),
  ]);
  return [...confirmed, ...candidates];
}
