// Per-KC misconception funnel, in two segments.
//
// Confirmed: live misconceptions linked through a non-archived `caused_by` edge. The
// promotion writer is flag-gated, so this is honestly empty on day one, never zero-filled.
// Candidates: pending conjecture proposals read directly from the inbox and filtered by
// knowledge_id; a global top-3 reader would hide real candidates for a given KC.
//
// Raw weight, confidence and probabilities never cross the wire. Confirmed confidence is
// a qualitative band computed locally; candidate confidence is fixed '低'. `seen` is a
// count and is allowed. This module only reads.

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { misconception, misconception_edge } from '@/db/schema';
import { listProposalInboxPage } from '@/kernel/proposals/inbox';

/** Qualitative confidence band — the only confidence signal that crosses the wire. */
export type MisconceptionConfBand = '高' | '中' | '低';

// Display-only even thirds. The low cut is reused as the fading threshold.
const CONF_LOW_HI = 0.34;
const CONF_MID_HI = 0.67;

function confBand(weight: number): MisconceptionConfBand {
  if (weight < CONF_LOW_HI) return '低';
  if (weight < CONF_MID_HI) return '中';
  return '高';
}

/** Short label cap; belief carries the full claim. */
const CANDIDATE_LABEL_CAP = 40;

// The inbox window is global and capped before the per-KC filter, so a conjecture past
// the top 50 is silently dropped, not deprioritized. Acceptable while pending volume is
// small; a growing set needs a knowledge_id predicate in the inbox query.
const CANDIDATE_SCAN_CAP = 50;

/** Defensive cap for one KC's confirmed rows. */
const CONFIRMED_CAP = 50;

/** One funnel row. Confidence is qualitative; raw probabilities are absent. */
export interface MisconceptionRow {
  /**
   * Segment-scoped: a misconception id for confirmed rows, a proposal event id for
   * candidates. Actions must key on `segment` too, because the id spaces differ.
   */
  id: string;
  segment: 'confirmed' | 'candidate';
  label: string;
  belief: string;
  /** Display projection; retracted rows never surface. */
  status: 'active' | 'fading';
  source: 'hard' | 'soft';
  conf: MisconceptionConfBand;
  seen: number;
  /** Event ids only, so every link the UI renders is live. */
  evidence: string[];
}

function clampHead(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** Live `caused_by` edges to active misconceptions. */
async function loadConfirmed(db: Db, kcId: string): Promise<MisconceptionRow[]> {
  const rows = await db
    .select({
      id: misconception.id,
      title: misconception.title,
      reasoning: misconception.reasoning,
      // Read locally for the band; never selected into the wire row.
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
    // Most recurrent first; id tiebreak keeps capped ordering deterministic.
    .orderBy(desc(misconception.seen), desc(misconception.id))
    .limit(CONFIRMED_CAP);

  return rows.map((r) => {
    const band = confBand(r.weight ?? 1);
    return {
      id: r.id,
      segment: 'confirmed' as const,
      label: r.title,
      belief: r.reasoning ?? '',
      // Fading reuses the low band, so there is no second threshold.
      status: band === '低' ? 'fading' : 'active',
      source: r.source === 'hard' ? 'hard' : 'soft',
      conf: band,
      seen: r.seen,
      evidence: r.evidence,
    };
  });
}

/** Pending conjectures for one KC. */
async function loadCandidates(db: Db, kcId: string): Promise<MisconceptionRow[]> {
  const { rows } = await listProposalInboxPage(db, {
    status: 'pending',
    kind: 'conjecture',
    limit: CANDIDATE_SCAN_CAP,
  });

  const candidates = rows.flatMap((row): MisconceptionRow[] => {
    if (row.payload.kind !== 'conjecture') return [];
    const change = row.payload.proposed_change;
    // The inbox window is global; keep only this KC.
    if (change.knowledge_id !== kcId) return [];
    // Confidence fields are deliberately unread: a candidate is fixed '低', and
    // ordering uses recurrence count.
    return [
      {
        id: row.id,
        segment: 'candidate',
        label: clampHead(change.claim_md, CANDIDATE_LABEL_CAP),
        belief: change.claim_md,
        // A pending conjecture is actively tracked, never fading.
        status: 'active',
        source: 'soft',
        conf: '低',
        seen: change.recurrence_count,
        // Drop non-event refs; rendering them as event links would create dead links.
        evidence: row.payload.evidence_refs
          .filter((ref) => ref.kind === 'event')
          .map((ref) => ref.id),
      },
    ];
  });

  // Recurrence is the only ordering signal (not confidence); id tiebreaks.
  return candidates.sort((a, b) => b.seen - a.seen || a.id.localeCompare(b.id));
}

/**
 * Confirmed rows first, then candidates. Empty means no misconceptions, never a
 * zero-filled placeholder.
 */
export async function loadMisconceptionsForKc(db: Db, kcId: string): Promise<MisconceptionRow[]> {
  const [confirmed, candidates] = await Promise.all([
    loadConfirmed(db, kcId),
    loadCandidates(db, kcId),
  ]);
  // Promotion accepts the source conjecture, so it leaves pending and cannot surface
  // twice.
  return [...confirmed, ...candidates];
}
