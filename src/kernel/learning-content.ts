// YUK-1763 — the interactive artifact answer-key serve boundary. The retired
// artifact-authoring tools (deleted under YUK-1773) wrote answers into stored
// HTML (`data-copilot-answer`) and into tool-call payloads (html +
// content_validation manifest). Historical rows and tool_use events still
// carry those payloads, so the invariant lives at every serve seam: nothing
// browser-facing may carry an answer key.

/** Tool names whose stored args carry interactive-artifact HTML and the answer manifest. */
export const INTERACTIVE_ARTIFACT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'author_artifact',
  'update_artifact',
]);

// The name must not be preceded by a name character, so `<div/data-answer=…>` and
// `"x"data-correct=…` (both parsed as attributes by browsers) are caught too.
const ANSWER_KEY_ATTRIBUTE_PATTERN =
  /(?<![\w-])data-(?:(?:copilot-)?answer|correct)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/**
 * Remove answer-key attributes from stored interactive HTML at serve time.
 * Covers `data-copilot-answer`, `data-answer` and `data-correct` with any
 * attribute-name casing and double/single/unquoted values; adjacent names like
 * `data-answers=` or `data-correct-format=` do not match (a value must follow
 * the exact name). Question bindings (`data-copilot-question-id`) stay.
 */
export function stripInteractiveAnswerAttributes(html: string): string {
  return html.replace(ANSWER_KEY_ATTRIBUTE_PATTERN, '');
}

/**
 * Redact an artifact-authoring tool's stored args at browser-facing seams:
 * strip answer attributes from the HTML and drop the answer manifest wholesale
 * (reference_md IS the answer key). Server-side storage is untouched — only
 * the served projection changes.
 */
export function redactInteractiveArtifactToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...input };
  if (typeof redacted.html === 'string') {
    redacted.html = stripInteractiveAnswerAttributes(redacted.html);
  }
  if (redacted.content_validation !== undefined) {
    redacted.content_validation = { redacted: 'answer_manifest' };
  }
  return redacted;
}
