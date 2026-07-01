// YUK-533 (ADR-0036 RT1 consumer) — confusable_with → contrast-question supply discovery.
//
// The PARALLEL sibling of target-discovery.ts:discoverSupplyTargets. Where that source
// scans the single-KC coverage pool (frontier / quality / diagnostic / format gaps), THIS
// source scans the confusable_with misconception mesh and emits one supply target per
// confusable KC pair: "the learner repeatedly confuses A and B → there is no contrast/
// discrimination item probing the A-vs-B boundary → generate one".
//
// 选题 vs 供给 mirror (architecture doc §Executive Summary): this is the供给 side — it
// decides "the pool lacks a contrast item for this confusable pair, go acquire it via
// quiz_gen". It does NOT pick today's practice order, does NOT call the LLM, does NOT
// insert questions. Dispatch to the existing quiz_gen face is dispatcher.ts's job.
//
// RED LINES:
//   - DARK behind CONFUSABLE_CONTRAST_ENABLED (default OFF). Flag-OFF ⇒ NO-OP ([]),
//     so day-one (no live producer of confusable_with edges + flag off) this is doubly
//     inert. The flip is deferred; the seam is fully built ([defer flip not build]).
//   - G-COST: emits TARGETS only. The dispatcher (7d fingerprint cooldown + per-run cap)
//     is the single paid-acquisition throttle. This source NEVER enqueues quiz_gen直接.
//   - ND-5 / ADR-0035 三轴正交: the confusable edge weight (read as a qualitative band by
//     the reader) NEVER feeds priority/difficulty — priority is the fixed gap base demand
//     (computePriority(gapKind, 0)); the generated contrast item takes an INDEPENDENT
//     b-anchor (ItemPriorTask), never inheriting edge confidence.
//   - propose-only: the target routes to quiz_gen, whose handler persists drafts with
//     draft_status='draft' (NEVER auto-active). minSourceTier=3 so the route planner falls
//     through to routePreference=['quiz_gen'] (the higher-tier/objective branches would
//     divert to sourcing_web/author_question).

import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import { loadConfusablePairs } from '@/capabilities/knowledge/server/misconception-confusable-read';
import type { Db } from '@/db/client';
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  type DifficultyBand,
  type QuestionSupplyTarget,
  type SupplyGapKind,
  type SupplyRoute,
  computePriority,
  targetFingerprint,
} from './target-discovery';

/**
 * Dark-ship flag. Default OFF — env-getter (read per-call) so tests parameterize OFF/ON and
 * the three processes (API / worker / Vite) each see it via their own env. Mirrors
 * misconception-promote.ts:misconceptionPromoteEnabled (NOT a const boolean — must be
 * runtime-mockable). OFF ⇒ discoverConfusableContrastTargets is a NO-OP.
 */
export function confusableContrastEnabled(): boolean {
  return process.env.CONFUSABLE_CONTRAST_ENABLED === '1';
}

// A contrast/discrimination item is naturally OBJECTIVE (present A and B, ask to
// distinguish) → 'choice'. NB: we do NOT set constraints.objectiveOnly — that branch in
// planSupplyRoutes diverts to sourcing_web/author_question; the kind hint alone keeps the
// generated item objective (quiz_gen honours the kind pin via kindsMatch).
const CONFUSABLE_CONTRAST_KIND = 'choice';

const GAP_KIND: SupplyGapKind = 'confusable_contrast';
// near band + tier-3 (generation-level) so planSupplyRoutes falls through to routePreference.
const DIFFICULTY_BAND: DifficultyBand = 'near';
const MIN_SOURCE_TIER = 3 as const;
const ROUTE_PREFERENCE: SupplyRoute[] = ['quiz_gen'];

/**
 * End-to-end read-only discovery: read the confusable mesh → emit one QuestionSupplyTarget
 * per confusable KC pair (priority desc). NO-OP ([]) when the flag is OFF. Zero write, zero
 * LLM. Mirrors target-discovery.ts:discoverSupplyTargets's load→scan→emit shape.
 */
export async function discoverConfusableContrastTargets(
  db: Db,
  makeId: () => string = () => Math.random().toString(36).slice(2),
): Promise<QuestionSupplyTarget[]> {
  if (!confusableContrastEnabled()) return []; // dark — flag OFF NO-OP.

  const pairs = await loadConfusablePairs(db);
  if (pairs.length === 0) return [];

  const targets: QuestionSupplyTarget[] = [];
  // Memoize subject resolution by first-KC: getEffectiveDomain walks the KC tree (up to
  // MAX_DEPTH=32 serial SELECTs per call), and confusable pairs frequently share a first KC,
  // so cache the resolved subject id to avoid the redundant per-pair tree-walk.
  const subjectByFirstKc = new Map<string, string>();
  for (const pair of pairs) {
    const knowledgeIds = [...pair.knowledgeIds];
    // subject is a DERIVED view (never stored) — resolve from the first KC's effective
    // domain (confusable KCs are typically same-subject). Unresolved → default profile.
    const firstKc = knowledgeIds[0];
    let subjectId = subjectByFirstKc.get(firstKc);
    if (subjectId === undefined) {
      try {
        subjectId = resolveSubjectProfile(await getEffectiveDomain(db, firstKc)).id;
      } catch {
        subjectId = resolveSubjectProfile(null).id;
      }
      subjectByFirstKc.set(firstKc, subjectId);
    }
    const fingerprint = targetFingerprint({
      subjectId,
      knowledgeIds,
      kind: CONFUSABLE_CONTRAST_KIND,
      difficultyBand: DIFFICULTY_BAND,
      gapKind: GAP_KIND,
      minSourceTier: MIN_SOURCE_TIER,
    });
    targets.push({
      id: makeId(),
      fingerprint,
      gapKind: GAP_KIND,
      subjectId,
      knowledgeIds,
      kind: CONFUSABLE_CONTRAST_KIND,
      difficultyBand: DIFFICULTY_BAND,
      desiredCount: 1,
      minSourceTier: MIN_SOURCE_TIER,
      routePreference: ROUTE_PREFERENCE,
      // priority is the FIXED gap base demand — the edge confidence band NEVER feeds it
      // (ND-5 三轴正交). conf only appears as a qualitative tag in the human-readable reason.
      priority: computePriority(GAP_KIND, 0),
      reason: `confusable pair [${knowledgeIds.join(' ↔ ')}] (conf=${pair.conf}) lacks a contrast/discrimination item`,
      constraints: {},
    });
  }

  // priority desc (stable: same priority keeps insertion order) — mirror scanCoverageGaps tail.
  return targets
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.priority - a.t.priority || a.i - b.i)
    .map(({ t }) => t);
}
