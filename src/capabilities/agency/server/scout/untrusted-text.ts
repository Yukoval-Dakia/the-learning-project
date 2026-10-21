// Learner-text handling: <untrusted_learner_text> delimiting + shared truncation cap.
//
// The evidence MCP returns learner-AUTHORED free text (answer_md / prompt_md /
// reference_md / note body) to a tool-loop agent (director + scout). That text is
// DATA, never instruction: a prompt-injection payload embedded in a learner's own
// answer must never redirect the agent, so every learner-authored string is wrapped
// in an explicit delimiter block.
//
// This is a red-line backstop, NOT the only defence: the agent prompt also states the
// framing, and propose_conjecture's primary-evidence check
// (report-findings.ts filterPrimaryEvidenceRefs) is the structural stop that keeps a
// poisoned finding from laundering agent_note ids into evidence.

export const UNTRUSTED_OPEN = '<untrusted_learner_text>';
export const UNTRUSTED_CLOSE = '</untrusted_learner_text>';

/**
 * Shared char cap for learner / question free text handed to an LLM, so the wrap +
 * truncate discipline cannot drift between the evidence tools and the conjecture
 * induction evidence packet.
 */
export const UNTRUSTED_TEXT_CHAR_CAP = 2000;

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export function truncateNullable(text: string | null, max: number): string | null {
  return text === null ? null : truncate(text, max);
}

/**
 * The full three-step discipline in one call: truncate FIRST, then delimit — so
 * the closing tag can never be cut off by the cap. `null` passes through
 * (absent field ≠ empty learner string).
 */
export function wrapTruncatedLearnerText(text: string, max?: number): string;
export function wrapTruncatedLearnerText(text: null, max?: number): null;
export function wrapTruncatedLearnerText(text: string | null, max?: number): string | null;
export function wrapTruncatedLearnerText(
  text: string | null,
  max: number = UNTRUSTED_TEXT_CHAR_CAP,
): string | null {
  return wrapUntrustedLearnerText(truncateNullable(text, max));
}

// Learner text containing the literal delimiter tokens (any casing) could close the
// untrusted block early and plant instruction-shaped text OUTSIDE the boundary. Defang
// embedded tokens into an HTML-entity form that can never terminate the block, applied
// to BOTH open and close so a payload can't fabricate nested blocks.
const EMBEDDED_DELIMITER = /<(\/?)(untrusted_learner_text)>/gi;

function defangEmbeddedDelimiters(text: string): string {
  return text.replace(EMBEDDED_DELIMITER, '&lt;$1$2&gt;');
}

/**
 * Wrap learner-authored free text in the <untrusted_learner_text> delimiter block.
 *
 * `null` passes through unchanged — an ABSENT field is not the same as an empty
 * learner string, and callers rely on null staying null (evidence absence is itself
 * signal). An empty string IS wrapped: the learner produced a (blank) answer, which is
 * distinct from no answer at all.
 */
export function wrapUntrustedLearnerText(text: string): string;
export function wrapUntrustedLearnerText(text: null): null;
export function wrapUntrustedLearnerText(text: string | null): string | null;
export function wrapUntrustedLearnerText(text: string | null): string | null {
  if (text === null) return null;
  return `${UNTRUSTED_OPEN}${defangEmbeddedDelimiters(text)}${UNTRUSTED_CLOSE}`;
}
