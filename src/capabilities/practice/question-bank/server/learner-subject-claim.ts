// A new subject is created only from the learner's own declaration: the first clause
// must anchor an explicit study intent whose object is exactly the claimed name.
// Pasted material, reported speech, negations, quoted names and multi-subject claims
// never qualify. Deterministic on purpose — the model decides what to pass as
// subject_id, never whether a subject is created. When in doubt, do not create.

const MAX_SUBJECT_NAME_LENGTH = 24;
const MAX_MESSAGE_LENGTH = 40;

// A subject name is a standalone label. Punctuation or whitespace means the caller
// passed a phrase (or a whole request), not a subject.
const NOT_A_NAME = /[\s，。！？；：、,.!?;:()（）「」『』“”"']/u;

// Quotes/title marks mean the claim is being quoted, not declared.
const QUOTED = /[「」『』“”‘’"'《》〈〉]/u;

// Reported speech or translation: the learner is relaying someone/something else.
const REPORTED = /说|让我|翻译/u;

// Two disciplines in one name ("日语和英语") are one claim too many.
const CONJUNCTION = /[和与及、或跟]|还是/u;

// Clause boundaries used to locate the learner's own declaration.
const CLAUSE_BREAK = /[，。！？；：、,.!?;:\r\n]/u;

const MULTILINE = /[\r\n]/u;

const ESCAPE_REGEXP = /[.*+?^${}()|[\]\\]/g;

/**
 * Normalized subject name when the learner's first clause declares studying exactly
 * it, else undefined.
 *
 * Stops: pasted/multiline material, topics inside a question request, negations,
 * reported speech (说/让我/翻译), quoted names, conjunctions, names absent from the
 * message, names that do not run to the end of the first clause, and messages longer
 * than 40 characters.
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
  if (message.length > MAX_MESSAGE_LENGTH) return undefined;
  if (MULTILINE.test(message)) return undefined;
  if (QUOTED.test(message) || REPORTED.test(message)) return undefined;
  if (!message.includes(name)) return undefined;
  const firstClause = message.split(CLAUSE_BREAK)[0]?.trim() ?? '';
  const declaration = new RegExp(
    `^我?(?:想|要|打算|准备|希望|开始|继续)(?:学习|自学|学)(?:好|一点|一些|一下)?${name.replace(
      ESCAPE_REGEXP,
      '\\$&',
    )}$`,
    'u',
  );
  return declaration.test(firstClause) ? name : undefined;
}
