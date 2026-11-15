export interface QuestionEvidenceOrigin {
  questionId: string;
}

function encodedId(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^[\p{L}\p{N}_.:-]+$/u.test(value) ||
    value === '.' ||
    value === '..'
  )
    return undefined;
  return encodeURIComponent(value);
}

export function readQuestionEvidenceOrigin(
  search: Record<string, unknown>,
): QuestionEvidenceOrigin | undefined {
  const questionId = search.questionId;
  if (
    search.evidenceOrigin !== 'question' ||
    typeof questionId !== 'string' ||
    !encodedId(questionId)
  )
    return undefined;
  return { questionId };
}

export function questionEvidenceHref(eventId: string, questionId: string): string {
  const event = encodedId(eventId);
  return event ? withQuestionEvidenceOrigin(`/events/${event}`, { questionId }) : '/questions';
}

export function withQuestionEvidenceOrigin(href: string, origin: QuestionEvidenceOrigin): string {
  if (!encodedId(origin.questionId)) return href;
  const event = /^\/events\/([^/?#]+)$/.exec(href);
  if (!event) return href;
  try {
    if (encodedId(decodeURIComponent(event[1])) !== event[1]) return href;
  } catch {
    return href;
  }
  const search = new URLSearchParams({
    evidenceOrigin: 'question',
    questionId: origin.questionId,
  });
  return `${href}?${search}`;
}

export function questionEvidenceReturnHref(origin: QuestionEvidenceOrigin): string {
  const question = encodedId(origin.questionId);
  return question ? `/questions/${question}#history` : '/questions';
}
