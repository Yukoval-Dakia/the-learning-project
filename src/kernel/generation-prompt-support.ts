import { KNOWN_QUESTION_KIND_IDS } from '@/core/schema/business';
import type { SubjectProfile } from '@/subjects/profile';

// YUK-386: kind is a free-form display label, not a closed behavioral enum.
// Prompts present the KNOWN labels as the conventional vocabulary to prefer —
// a suggestion list, not a validation gate. Behavioral authority lives in
// answer_class (exact | keyword | semantic | steps) and structural fields.
export const CANONICAL_QUESTION_KINDS = KNOWN_QUESTION_KIND_IDS.join(' | ');

export function rubricGuidanceSection(profile: SubjectProfile): string {
  const guidance = profile.promptFragments.rubricGuidance?.trim();
  return guidance
    ? `\n科目级 rubric 规范（写 rubric_json 的 criteria/keywords/required_points 时遵循）：${guidance}`
    : '';
}
