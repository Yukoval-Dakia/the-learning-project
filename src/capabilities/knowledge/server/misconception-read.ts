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
// SILENT-DROP TRADEOFF: the cap is applied to the GLOBAL recency window BEFORE the per-KC
// filter, so a KC's conjecture ranked beyond the global top-50 window is silently DROPPED
// (not just deprioritized). Acceptable while the single-user pending set stays small; if
// pending volume ever grows, this must become a SQL-level knowledge_id predicate pushed
// into listProposalInboxPage — bumping the scan cap would not fix the drop.
const CANDIDATE_SCAN_CAP = 50;

// Defensive row cap on the confirmed `caused_by` join. Single-KC scoped + dormant day-one
// (PR-3 writer is flag-gated), so this is degenerate-defense not a business cap — kept
// symmetric with CANDIDATE_SCAN_CAP. Owner-tunable; raise if a single KC ever legitimately
// accrues >50 live misconceptions.
const CONFIRMED_CAP = 50;

/**
 * One row in the per-KC misconception funnel. ALL confidence is qualitative — raw
 * weight / confidence / predicted_p / baseline_p are deliberately ABSENT from this type.
 */
export interface MisconceptionRow {
  /**
   * SEGMENT-SCOPED id — confirmed = misconception.id; candidate = proposal event id. The
   * two id spaces are disjoint substrates, so PR-5 MUST key actions on `segment` (never id
   * alone) to route to the right backend (live misconception vs pending-conjecture proposal).
   */
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
  /**
   * Evidence event-id back-links — event-ids ONLY. The candidate segment filters its
   * evidence_refs to kind==='event' (see loadCandidates), so non-event refs never reach
   * the wire and PR-5 can render every id as an event 回链 without dead links.
   */
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
    .orderBy(desc(misconception.seen), desc(misconception.id))
    .limit(CONFIRMED_CAP);

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
        // EVENT-回链 contract: ONLY kind==='event' refs cross the wire — uniform with the
        // confirmed segment (whose evidence is genuine event-ptrs) and the UI's event-回链
        // design. A conjecture's evidence_refs can also carry question/knowledge/artifact/
        // record kinds (e.g. the question whose recurrence induced it); those are
        // INTENTIONALLY DROPPED here — a non-event id rendered by PR-5 as an event backlink
        // would be a dead link.
        evidence: row.payload.evidence_refs
          .filter((ref) => ref.kind === 'event')
          .map((ref) => ref.id),
      },
    ];
  });

  // Most-recurrent first (recurrence_count is the only ordering signal; NOT confidence).
  // id.localeCompare is the deterministic tiebreaker for equal `seen` — Array.sort is not
  // guaranteed stable across equal keys, mirroring the confirmed segment's SQL desc(id).
  return candidates.sort((a, b) => b.seen - a.seen || a.id.localeCompare(b.id));
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
  // NO double-surfacing across segments: PR-3's promotion writer rides
  // acceptConjectureProposal, which writes a rate(accept) event so the source conjecture
  // leaves `pending` — a promoted belief therefore surfaces ONCE (as confirmed only), never
  // simultaneously as its originating candidate.
  return [...confirmed, ...candidates];
}
