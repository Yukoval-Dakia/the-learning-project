import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import { type TaskKind, type TaskPrompt, tasks } from './registry';

export type AiTaskKind = TaskKind;

// YUK-589 (High-sec) — boundary validation for an untrusted task-kind string.
// The judge invoker receives `kind` as a plain string from the runner seam and
// must NOT `as AiTaskKind`-cast it before feeding it to fingerprinting: an
// unknown kind would silently produce a bogus prompt fingerprint (fail-open).
// `tasks` is the single registry whose keys ARE the AiTaskKind union, so an own
// key is the authoritative membership test.
export function isAiTaskKind(kind: string): kind is AiTaskKind {
  return Object.hasOwn(tasks, kind);
}

function assertNever(value: never): never {
  throw new Error(
    `getTaskSystemPrompt: unhandled prompt kind — add a case to the switch. value=${JSON.stringify(value)}`,
  );
}

export function getTaskSystemPrompt(
  task: AiTaskKind,
  profile: SubjectProfile = resolveSubjectProfile(),
): string {
  const prompt: TaskPrompt = tasks[task].prompt;
  switch (prompt.kind) {
    case 'inline':
      return prompt.text;
    case 'profile':
      return prompt.build(profile);
    default:
      return assertNever(prompt);
  }
}
