import type { ConjectureProbeSpecV2T } from '@/core/schema/business';

export interface DeterministicProbeAnswerGroup {
  reference: string;
  signature: string[];
  signatureMatch: 'all' | 'some';
}

interface ChoiceOption {
  id: string;
  answer: string;
  markerIndex: number;
}

const CHOICE_MARKER =
  /(?:^|[\r\n]|\s)(?:\(\s*([\p{L}\p{N}_-]{1,20})\s*\)|（\s*([\p{L}\p{N}_-]{1,20})\s*）|\[\s*([\p{L}\p{N}_-]{1,20})\s*\]|([\p{L}\p{N}_-]{1,20})[.．、:：])\s*/gu;

function parseChoiceOptions(prompt: string): ChoiceOption[] {
  const matches = [...prompt.normalize('NFKC').matchAll(CHOICE_MARKER)];
  return matches.flatMap((match, index) => {
    const id = match[1] ?? match[2] ?? match[3] ?? match[4];
    const markerIndex = match.index;
    const answerStart = markerIndex + match[0].length;
    const answerEnd = matches[index + 1]?.index ?? prompt.length;
    const answer = prompt.slice(answerStart, answerEnd).trim();
    return id && answer ? [{ id: id.toLowerCase(), answer, markerIndex }] : [];
  });
}

function choiceSignatureAnswers(prompt: string, optionIds: string[]): string[] | null {
  const options = parseChoiceOptions(prompt);
  const answers = optionIds.map((id) =>
    options.find((option) => option.id === id.normalize('NFKC').trim().toLowerCase()),
  );
  return answers.every((answer) => answer !== undefined)
    ? answers.map((answer) => answer?.answer ?? '')
    : null;
}

function signatureAnswers(
  prompt: string,
  signature:
    | ConjectureProbeSpecV2T['gold_response_signature']
    | ConjectureProbeSpecV2T['target_error_response_signature'],
): { answers: string[]; match: 'all' | 'some' } | null {
  if (signature.kind === 'text') return { answers: [signature.response_md], match: 'all' };
  if (signature.kind === 'answer_with_reason') {
    return { answers: [signature.answer_md], match: 'all' };
  }
  if (signature.kind === 'choice') {
    const answers = choiceSignatureAnswers(prompt, signature.option_ids);
    return answers ? { answers, match: 'all' } : null;
  }
  return { answers: signature.required_features_md, match: 'some' };
}

export function deterministicProbeQuestionStem(probe: ConjectureProbeSpecV2T): string {
  const optionIds = [
    ...(probe.gold_response_signature.kind === 'choice'
      ? probe.gold_response_signature.option_ids
      : []),
    ...(probe.target_error_response_signature.kind === 'choice'
      ? probe.target_error_response_signature.option_ids
      : []),
  ].map((id) => id.normalize('NFKC').trim().toLowerCase());
  if (optionIds.length === 0) return probe.prompt_md;
  const firstSelectedOption = parseChoiceOptions(probe.prompt_md)
    .filter((option) => optionIds.includes(option.id))
    .sort((left, right) => left.markerIndex - right.markerIndex)[0];
  return firstSelectedOption
    ? probe.prompt_md.slice(0, firstSelectedOption.markerIndex).trim()
    : '';
}

export function deterministicProbeAnswers(probe: ConjectureProbeSpecV2T): {
  gold: DeterministicProbeAnswerGroup;
  target: DeterministicProbeAnswerGroup;
} | null {
  const goldSignature = signatureAnswers(probe.prompt_md, probe.gold_response_signature);
  const targetSignature = signatureAnswers(probe.prompt_md, probe.target_error_response_signature);
  if (!goldSignature || !targetSignature) return null;
  return {
    gold: {
      reference: probe.reference_md,
      signature: goldSignature.answers,
      signatureMatch: goldSignature.match,
    },
    target: {
      reference: probe.expected_target_error_answer_md,
      signature: targetSignature.answers,
      signatureMatch: targetSignature.match,
    },
  };
}

export function deterministicAnswerGroupMatches(
  group: DeterministicProbeAnswerGroup,
  matches: (answer: string) => boolean,
): boolean {
  if (!matches(group.reference) || group.signature.length === 0) return false;
  return group.signatureMatch === 'all'
    ? group.signature.every(matches)
    : group.signature.some(matches);
}
