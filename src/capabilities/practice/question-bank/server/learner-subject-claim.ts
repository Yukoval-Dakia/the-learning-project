// A new subject is created only from the learner's own words: an explicit study
// intent must name the claim. A topic inside a question request ("出几道二次函数
// 的题") never qualifies. Deterministic on purpose — the model decides what to pass
// as subject_id, never whether a subject is created.

const MAX_SUBJECT_NAME_LENGTH = 24;

// A subject name is a standalone label. Punctuation or whitespace means the caller
// passed a phrase (or a whole request), not a subject.
const NOT_A_NAME = /[\s，。！？；：、,.!?;:()（）「」『』“”"']/u;

/**
 * Normalized subject name when the learner explicitly asked to study it, else
 * undefined.
 *
 * Stops: topics mentioned inside a question/explanation request, names absent from
 * the learner's words, phrases and oversized claims.
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
  if (!message.includes(name)) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const studyIntent = new RegExp(
    `(?:想|要|打算|准备|希望|开始|继续)?\\s*(?:学习|自学|学)(?:好|一点|一些|一下)?\\s*${escaped}`,
    'u',
  );
  return studyIntent.test(message) ? name : undefined;
}
