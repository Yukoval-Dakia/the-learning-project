import { getConfig } from '@/core/config/store';
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

// YUK-1006 / YUK-1007 — only learner-facing generated text follows this locale.
// Keep the default pin byte-identical for existing prompt hashes. UI language,
// JSON keys, enum values, code and LaTeX are outside this setting's scope.
export const LEARNER_LOCALE_PIN =
  '\n\n【输出语言】所有面向用户展示的文本（回复正文、reasoning / reason_md、解释摘要、提案理由、chip 与卡片文案等）一律用简体中文书写；JSON 字段名、枚举值、代码与 LaTeX 记号不受影响。';

const ENGLISH_LEARNER_LOCALE_PIN =
  '\n\n[Output language] Write all user-visible text (reply body, reasoning / reason_md, explanation summaries, proposal reasons, chip and card copy) in English; JSON keys, enum values, code and LaTeX notation are unaffected.';

/** Read the current shared config snapshot on every prompt build, never at import time. */
export function getLearnerLocale(): 'zh-CN' | 'en' {
  return getConfig('locale.learner') === 'en' ? 'en' : 'zh-CN';
}

function learnerLocalePin(locale: 'zh-CN' | 'en'): string {
  return locale === 'en' ? ENGLISH_LEARNER_LOCALE_PIN : LEARNER_LOCALE_PIN;
}

export function getTaskSystemPrompt(
  task: AiTaskKind,
  profile: SubjectProfile = resolveSubjectProfile(),
  learnerLocale: 'zh-CN' | 'en' = getLearnerLocale(),
): string {
  const prompt: TaskPrompt = tasks[task].prompt;
  switch (prompt.kind) {
    case 'inline':
      return prompt.text + learnerLocalePin(learnerLocale);
    case 'profile':
      return prompt.build(profile) + learnerLocalePin(learnerLocale);
    case 'none':
      // YUK-1049 — typed tasks have no system prompt; runTask/streamTask
      // reject execution:'typed' before reaching this seam, so reaching here
      // is a routing bug, not a legitimate prompt.
      throw new Error(`task ${task} is a typed task with no system prompt`);
    default:
      return assertNever(prompt);
  }
}
