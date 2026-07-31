import type { ConjectureProbeSpecV2T } from '@/core/schema/business';

export interface DeterministicProbeAnswerGroup {
  reference: string;
  signature: string[];
  signatureMatch: 'all' | 'some';
  choice?: {
    options: Array<{ id: string; answer: string }>;
    selectedOptionIds: string[];
  };
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

function optionOrdinal(id: string): { prefix: string; ordinal: number } | null {
  if (/^[a-z]$/i.test(id)) return { prefix: 'letter', ordinal: id.toUpperCase().charCodeAt(0) };
  const numbered = /^(.*?)(\d+)$/.exec(id);
  return numbered
    ? { prefix: numbered[1]?.toLowerCase() ?? '', ordinal: Number(numbered[2]) }
    : null;
}

function optionsAreSequential(left: ChoiceOption, right: ChoiceOption): boolean {
  const leftOrdinal = optionOrdinal(left.id);
  const rightOrdinal = optionOrdinal(right.id);
  return (
    leftOrdinal !== null &&
    rightOrdinal !== null &&
    leftOrdinal.prefix === rightOrdinal.prefix &&
    rightOrdinal.ordinal === leftOrdinal.ordinal + 1
  );
}

function probeChoiceOptions(probe: ConjectureProbeSpecV2T): ChoiceOption[] | null {
  const selectedIds = [
    ...(probe.gold_response_signature.kind === 'choice'
      ? probe.gold_response_signature.option_ids
      : []),
    ...(probe.target_error_response_signature.kind === 'choice'
      ? probe.target_error_response_signature.option_ids
      : []),
  ].map((id) => id.normalize('NFKC').trim().toLowerCase());
  if (selectedIds.length === 0) return [];
  const options = parseChoiceOptions(probe.prompt_md);
  const selectedIndexes = selectedIds.map((id) => options.findIndex((option) => option.id === id));
  if (selectedIndexes.some((index) => index < 0)) return null;
  let start = Math.min(...selectedIndexes);
  let end = Math.max(...selectedIndexes);
  while (start > 0) {
    const previous = options[start - 1];
    const current = options[start];
    if (!previous || !current || !optionsAreSequential(previous, current)) break;
    start -= 1;
  }
  while (end + 1 < options.length) {
    const current = options[end];
    const next = options[end + 1];
    if (!current || !next || !optionsAreSequential(current, next)) break;
    end += 1;
  }
  const block = options.slice(start, end + 1);
  return selectedIds.every((id) => block.some((option) => option.id === id)) ? block : null;
}

function choiceSignatureAnswers(options: ChoiceOption[], optionIds: string[]): string[] | null {
  const answers = optionIds.map((id) =>
    options.find((option) => option.id === id.normalize('NFKC').trim().toLowerCase()),
  );
  return answers.every((answer) => answer !== undefined)
    ? answers.map((answer) => answer?.answer ?? '')
    : null;
}

function signatureAnswers(
  options: ChoiceOption[],
  signature:
    | ConjectureProbeSpecV2T['gold_response_signature']
    | ConjectureProbeSpecV2T['target_error_response_signature'],
): { answers: string[]; match: 'all' | 'some' } | null {
  if (signature.kind === 'text') return { answers: [signature.response_md], match: 'all' };
  if (signature.kind === 'answer_with_reason') {
    return { answers: [signature.answer_md], match: 'all' };
  }
  if (signature.kind === 'choice') {
    const answers = choiceSignatureAnswers(options, signature.option_ids);
    return answers ? { answers, match: 'all' } : null;
  }
  return { answers: signature.required_features_md, match: 'some' };
}

export function deterministicProbeQuestionStem(probe: ConjectureProbeSpecV2T): string {
  const options = probeChoiceOptions(probe);
  if (options?.length === 0) return probe.prompt_md;
  const firstOption = options?.[0];
  return firstOption ? probe.prompt_md.slice(0, firstOption.markerIndex).trim() : '';
}

export function deterministicProbeAnswers(probe: ConjectureProbeSpecV2T): {
  gold: DeterministicProbeAnswerGroup;
  target: DeterministicProbeAnswerGroup;
} | null {
  const choiceOptions = probeChoiceOptions(probe);
  if (!choiceOptions) return null;
  const goldSignature = signatureAnswers(choiceOptions, probe.gold_response_signature);
  const targetSignature = signatureAnswers(choiceOptions, probe.target_error_response_signature);
  if (!goldSignature || !targetSignature) return null;
  const choice = (signature: ConjectureProbeSpecV2T['gold_response_signature']) =>
    signature.kind === 'choice'
      ? {
          options: choiceOptions.map(({ id, answer }) => ({ id, answer })),
          selectedOptionIds: signature.option_ids.map((id) =>
            id.normalize('NFKC').trim().toLowerCase(),
          ),
        }
      : undefined;
  return {
    gold: {
      reference: probe.reference_md,
      signature: goldSignature.answers,
      signatureMatch: goldSignature.match,
      choice: choice(probe.gold_response_signature),
    },
    target: {
      reference: probe.expected_target_error_answer_md,
      signature: targetSignature.answers,
      signatureMatch: targetSignature.match,
      choice: choice(probe.target_error_response_signature),
    },
  };
}

export function deterministicAnswerGroupMatches(
  group: DeterministicProbeAnswerGroup,
  matches: (answer: string) => boolean,
): boolean {
  if (!matches(group.reference) || group.signature.length === 0) return false;
  if (group.choice) {
    const expectedIds = group.choice.options
      .filter((option) => matches(option.answer))
      .map((option) => option.id)
      .sort();
    const selectedIds = [...group.choice.selectedOptionIds].sort();
    return (
      expectedIds.length === selectedIds.length &&
      expectedIds.every((id, index) => id === selectedIds[index])
    );
  }
  return group.signatureMatch === 'all'
    ? group.signature.every(matches)
    : group.signature.some(matches);
}
