import { createHash } from 'node:crypto';
import type { AiTaskKind } from '@/ai/task-prompts';
import { getTaskSystemPrompt } from '@/ai/task-prompts';
import type { SubjectProfile } from '@/subjects/profile';

export const JUDGE_PROMPT_ENVELOPE_VERSION = 1 as const;
export const JUDGE_PROMPT_TEMPLATE_REVISION = 'judge-prompt-v1' as const;

export function stableCanonicalValue(value: unknown): unknown {
  if (value instanceof URL) return value.toString();
  if (value instanceof Uint8Array) {
    return {
      _type: 'bytes',
      byteLength: value.byteLength,
      sha256: createHash('sha256').update(value).digest('hex'),
    };
  }
  if (Array.isArray(value)) return value.map(stableCanonicalValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableCanonicalValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableCanonicalValue(value)) ?? 'null')
    .digest('hex');
}

export function taskInputHash(input: unknown): string {
  return sha256Canonical(input);
}

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
          : JSON.stringify(stableCanonicalValue(input.taskInput)),
    },
    subject_profile: { id: input.subjectProfile.id, version: input.subjectProfile.version },
    judge_route: input.judgeRoute,
    prompt_template_revision: JUDGE_PROMPT_TEMPLATE_REVISION,
  });
}
