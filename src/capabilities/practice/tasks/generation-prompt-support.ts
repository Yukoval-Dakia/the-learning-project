import type { SubjectProfile } from '@/subjects/profile';

export const CANONICAL_QUESTION_KINDS =
  'choice | true_false | fill_blank | short_answer | essay | computation | reading | translation | derivation';

export function rubricGuidanceSection(profile: SubjectProfile): string {
  const guidance = profile.promptFragments.rubricGuidance?.trim();
  return guidance
    ? `\n科目级 rubric 规范（写 rubric_json 的 criteria/keywords/required_points 时遵循）：${guidance}`
    : '';
}
