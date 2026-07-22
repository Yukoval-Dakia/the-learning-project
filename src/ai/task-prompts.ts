import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import { type TaskKind, type TaskPrompt, tasks } from './registry';

export type AiTaskKind = TaskKind;

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
