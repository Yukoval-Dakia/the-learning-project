// Confusable-pair contrast-question supply discovery.
// Scans the confusable_with misconception mesh and emits one supply target per confusable
// KC pair: the learner repeatedly confuses A and B, no contrast item probes that boundary,
// so acquire one through quiz_gen. This source does not pick practice order, call the LLM,
// or insert questions; dispatcher.ts owns dispatch and the paid-acquisition throttle.
// Constraints:
// - dark behind CONFUSABLE_CONTRAST_ENABLED (default off): flag-off is a no-op;
// - emits targets only and never enqueues quiz_gen directly;
// - edge confidence never feeds priority or difficulty; a generated contrast item takes
// an independent b-anchor (ItemPriorTask) and never inherits edge confidence;
// - propose-only: quiz_gen persists drafts (draft_status='draft'), never auto-active;
// minSourceTier=3 keeps the route preference on quiz_gen instead of sourcing_web or
// author_question.

import { getConfigFlag } from '@/core/config/store';
import type { Db } from '@/db/client';
import { loadConfusablePairs } from '@/kernel/read-models/confusables';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { resolveSubjectProfile } from '@/subjects/profile';
import { buildCoverageEvidenceDemand, evidenceDemandToTargetContext } from './evidence-demand';
import {
  type DifficultyBand,
  type QuestionSupplyTarget,
  type SupplyGapKind,
  type SupplyRoute,
  computePriority,
  targetFingerprint,
} from './target-discovery';

/**
 * Dark-ship flag, default off. Read per call so tests can toggle it and each process sees
 * its own env. Off means discoverConfusableContrastTargets is a no-op.
 */
export function confusableContrastEnabled(): boolean {
  // DB > env > code default (false).
  return getConfigFlag('CONFUSABLE_CONTRAST_ENABLED');
}

// A contrast/discrimination item is naturally OBJECTIVE (present A and B, ask to
// distinguish) → 'choice'. The objectiveOnly constraint preserves the runtime kind
// gate; route-planner keeps this gap's explicit quiz_gen-only route preference.
const CONFUSABLE_CONTRAST_KIND = 'choice';

const GAP_KIND: SupplyGapKind = 'confusable_contrast';
// near band + tier-3 (generation-level) so planSupplyRoutes falls through to routePreference.
const DIFFICULTY_BAND: DifficultyBand = 'near';
const MIN_SOURCE_TIER = 3 as const;
const ROUTE_PREFERENCE: SupplyRoute[] = ['quiz_gen'];

/**
 * Read-only discovery: load the confusable mesh → emit one target per pair (priority desc).
 * No-op when the flag is off; zero writes and zero LLM calls.
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
      // Priority is the fixed gap base demand; edge confidence never feeds it. Confidence
      // appears only as a qualitative tag in the human-readable reason.
      priority: computePriority(GAP_KIND, 0),
      reason: `confusable pair [${knowledgeIds.join(' ↔ ')}] (conf=${pair.conf}) lacks a contrast/discrimination item`,
      constraints: { objectiveOnly: true },
      context: evidenceDemandToTargetContext(
        buildCoverageEvidenceDemand({
          subjectId,
          knowledgeIds,
          statement: `distinguish confusable knowledge pair ${knowledgeIds.join(' and ')}`,
          kinds: [CONFUSABLE_CONTRAST_KIND],
          allowedUses: ['practice', 'diagnostic'],
          difficultyBand: DIFFICULTY_BAND,
          eligibleCount: 1,
          cause: { kind: 'confusable_pair' },
        }),
      ),
    });
  }

  // priority desc (stable: same priority keeps insertion order) — mirror scanCoverageGaps tail.
  return targets
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.priority - a.t.priority || a.i - b.i)
    .map(({ t }) => t);
}
