// A new subject is created only from the learner's own declaration: one clause must
// anchor an explicit study intent whose object is exactly the claimed name. A topic
// inside a question request ("出几道二次函数的题"), a negation, or reported speech
// never qualifies. Deterministic on purpose — the model decides what to pass as
// subject_id, never whether a subject is created. When in doubt, do not create.

const MAX_SUBJECT_NAME_LENGTH = 24;

// A subject name is a standalone label. Punctuation or whitespace means the caller
// passed a phrase (or a whole request), not a subject.
const NOT_A_NAME = /[\s，。！？；：、,.!?;:()（）「」『』“”"']/u;

// Quotes/title marks mean the claim is being quoted, not declared.
const QUOTED = /[「」『』“”‘’"'《》〈〉]/u;

// Reported speech or translation: the learner is relaying someone/something else.
const REPORTED = /说|让我|翻译/u;

// Two disciplines in one name ("日语和英语") are one claim too many.
const CONJUNCTION = /[和与及、]/u;

// Clause boundaries used to locate the learner's own declaration.
const CLAUSE_BREAK = /[，。！？；：、,.!?;:\n]/u;

const ESCAPE_REGEXP = /[.*+?^${}()|[\]\\]/g;

/**
 * Normalized subject name when the learner's own clause declares studying exactly
 * it, else undefined.
 *
 * Stops: topics mentioned inside a question/explanation request, negations,
 * reported speech (说/让我/翻译), quoted names, conjunctions, names absent from the
 * message, and names that do not run to the end of their clause.
 * Does not stop: a learner saying they want to learn a topic-like phrase
 * ("我想学二次函数") — that is study intent in the learner's own words. The gate is
 * lexical, not a discipline classifier.
 */
export function learnerStatedSubject(
  message: string,
  claim: string | undefined,
): string | undefined {
  if (claim === undefined) return undefined;
  const name = claim.normalize('NFC').trim();
  if (name.length === 0 || name.length > MAX_SUBJECT_NAME_LENGTH) return undefined;
  if (NOT_A_NAME.test(name)) return undefined;
  if (CONJUNCTION.test(name)) return undefined;
  if (QUOTED.test(message) || REPORTED.test(message)) return undefined;
  if (!message.includes(name)) return undefined;
  const declaration = new RegExp(
    `^我?(?:想|要|打算|准备|希望|开始|继续)(?:学习|自学|学)(?:好|一点|一些|一下)?${name.replace(
      ESCAPE_REGEXP,
      '\\$&',
    )}$`,
    'u',
  );
  return message.split(CLAUSE_BREAK).some((clause) => declaration.test(clause.trim()))
    ? name
    : undefined;
}
