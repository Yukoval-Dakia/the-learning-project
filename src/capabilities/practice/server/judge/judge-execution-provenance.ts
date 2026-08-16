import type { AiTaskKind } from '@/ai/task-prompts';
import { getTaskSystemPrompt } from '@/ai/task-prompts';
import { sha256Canonical, stableCanonicalValue } from '@/server/ai/task-input-hash';
import type { SubjectProfile } from '@/subjects/profile';
export const JUDGE_PROMPT_ENVELOPE_VERSION = 1 as const;
export const JUDGE_PROMPT_TEMPLATE_REVISION = 'judge-prompt-v1' as const;

export { sha256Canonical, stableCanonicalValue, taskInputHash } from '@/server/ai/task-input-hash';

export function judgePromptFingerprint(input: {
  taskKind: AiTaskKind;
  taskInput: unknown;
  subjectProfile: SubjectProfile;
  judgeRoute: string;
}): string {
  return sha256Canonical({
    version: JUDGE_PROMPT_ENVELOPE_VERSION,
    task_kind: input.taskKind,
    canonical_model_input: {
      system: getTaskSystemPrompt(input.taskKind, input.subjectProfile),
      user:
        typeof input.taskInput === 'string'
          ? input.taskInput
          : // YUK-589 (K4b) — JSON.stringify returns `undefined` for an undefined
            // (or otherwise unrenderable) canonical value; the concat below would
            // then stringify the literal "undefined", colliding distinct inputs.
            // Mirror sha256Canonical's `?? 'null'` fallback.
            (JSON.stringify(stableCanonicalValue(input.taskInput)) ?? 'null'),
    },
    subject_profile: { id: input.subjectProfile.id, version: input.subjectProfile.version },
    judge_route: input.judgeRoute,
    prompt_template_revision: JUDGE_PROMPT_TEMPLATE_REVISION,
  });
}
