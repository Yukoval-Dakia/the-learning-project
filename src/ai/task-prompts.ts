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

// YUK-1006 — learner-facing locale pin, appended to EVERY task system prompt at
// this single funnel (runner.ts passes getTaskSystemPrompt output verbatim).
// Free-generated user-visible fields (proposal reasoning / reason_md, judge
// explanations, intervention copy, chip 文案) previously drifted to the model's
// default language. The pin covers user-visible text only — structured output
// (JSON keys, enum values, LaTeX, code) is unaffected. UI locale is currently
// hardcoded 简体中文; per-user locale plumbing is the settings-panel ticket's
// long-term scope (YUK-1007).
export const LEARNER_LOCALE_PIN =
  '\n\n【输出语言】所有面向用户展示的文本（回复正文、reasoning / reason_md、解释摘要、提案理由、chip 与卡片文案等）一律用简体中文书写；JSON 字段名、枚举值、代码与 LaTeX 记号不受影响。';

export function getTaskSystemPrompt(
  task: AiTaskKind,
  profile: SubjectProfile = resolveSubjectProfile(),
): string {
  const prompt: TaskPrompt = tasks[task].prompt;
  switch (prompt.kind) {
    case 'inline':
      return prompt.text + LEARNER_LOCALE_PIN;
    case 'profile':
      return prompt.build(profile) + LEARNER_LOCALE_PIN;
    default:
      return assertNever(prompt);
  }
}
