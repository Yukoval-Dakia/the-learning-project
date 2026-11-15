import { A5_BANDS, UNKNOWN_BAND_LABEL, masteryBandView } from '@/core/mastery-band';
import type { Tx } from '@/db/client';
import { readLearnerProfilesAsBatch } from '@/kernel/learner-profile/read';
import { readCauseJudgment } from '@/kernel/read-models/cause-judgment';
import { getFailureAttemptsForDerivation } from '@/kernel/read-models/failure-attempts';
import { listDerivableActiveMisconceptionsForKcs } from '@/kernel/read-models/failure-learning-context';
import type { TeachingLearnerPicture } from '../../tasks/teaching-turn';

// The caller owns the read-only repeatable-read snapshot, including KC selection.
export async function loadTeachingLearnerPicture(
  tx: Tx,
  firstKnowledgeId: string | undefined,
  asOf: Date,
): Promise<TeachingLearnerPicture | null> {
  if (!firstKnowledgeId) return null;
  const [profiles, causes, failures, misconceptions] = await Promise.all([
    readLearnerProfilesAsBatch(tx, {
      knowledge_ids: [firstKnowledgeId],
      as_of: asOf,
      context: 'any',
    }),
    readCauseJudgment(tx, { knowledge_ids: [firstKnowledgeId], as_of: asOf }),
    getFailureAttemptsForDerivation(tx, { limit: 200 }),
    listDerivableActiveMisconceptionsForKcs(tx, [firstKnowledgeId]),
  ]);
  const profile = profiles.items.find((item) => item.knowledge_id === firstKnowledgeId);
  const ability = profile?.ability;
  const mastery = ability?.kind === 'available' ? masteryBandView(ability.reading) : null;
  const topCauses = causes.items.find((item) => item.knowledge_id === firstKnowledgeId)?.top_causes;
  const permittedTitles = new Map(misconceptions.map((row) => [row.id, row.title]));

  return {
    selection: 'first_learning_item_kc',
    knowledge_id: firstKnowledgeId,
    as_of: asOf.toISOString(),
    mastery_band: mastery && !mastery.unknown ? A5_BANDS[mastery.band] : UNKNOWN_BAND_LABEL,
    independent_evidence: profile?.uncertainty.independent_evidence ?? {
      kind: 'unknown',
      reason: 'learner_profile_unavailable',
    },
    top_causes:
      topCauses?.known && topCauses.value !== null
        ? topCauses.value.slice(0, 3).map(({ category, count }) => ({
            category,
            // Display labels have no derivation authority; use only the permitted owner title.
            label: permittedTitles.get(category)?.slice(0, 120) ?? null,
            count,
          }))
        : null,
    // Keep only plain answer text; image/link-bearing answers never forward attachments.
    recent_wrong_answers: failures
      .flatMap((failure) => {
        const answer = failure.answer_md?.trim();
        if (
          !failure.referenced_knowledge_ids.includes(firstKnowledgeId) ||
          !answer ||
          failure.answer_image_refs.length > 0 ||
          /!?\[[^\]]*\]\s*[[(]|https?:|data:|attachment:|<[^>]+>/i.test(answer)
        )
          return [];
        return [{ answer_excerpt: answer.slice(0, 400), at: failure.created_at.toISOString() }];
      })
      .slice(0, 2),
    active_misconceptions: misconceptions.slice(0, 5).map((row) => row.title.slice(0, 120)),
  };
}
