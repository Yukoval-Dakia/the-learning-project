// Three separate facts about one answer, in the words of the result card: what help was looked at,
// how it was judged, and what the learner said. Independence is the server's verdict; nothing here
// works it out, and a fact the server doesn't have gets no line.

import type { SubmitResult } from './practice-api';

export type AttemptEvidence = Extract<SubmitResult, { evidence: unknown }>['evidence'];

/** A settled run's result is untyped here; anything without the three parts is no evidence. */
export function attemptEvidenceOf(result: unknown): AttemptEvidence | null {
  if (!result || typeof result !== 'object' || !('evidence' in result)) return null;
  const evidence = result.evidence;
  return evidence && typeof evidence === 'object' && 'assistance' in evidence
    ? (evidence as AttemptEvidence)
    : null;
}

export interface AttemptFact {
  label: string;
  value: string;
}

/**
 * Looking at a hint reads as `unknown` from the server and looking at an answer as `assisted`;
 * either way it isn't independent. `independent` means nothing was looked at before submitting.
 */
function helpWords(help: NonNullable<AttemptEvidence['assistance']>): string {
  if (help.status === 'independent') {
    return help.phase === 'after_submit'
      ? '交了之后才看的，这次算独立做的'
      : '没看提示，这次算独立做的';
  }
  const seen = help.kinds.includes('solution')
    ? '看过完整解'
    : help.kinds.includes('hint')
      ? help.max_dose === null
        ? '看过提示'
        : `看过第 ${help.max_dose + 1} 个提示`
      : help.kinds.includes('chat_context')
        ? '和学伴聊过这题'
        : '看没看过帮助没记全';
  return `${seen}，这次不算独立做的`;
}

const VERDICT_WORDS: Record<NonNullable<AttemptEvidence['verdict']>['outcome'], string> = {
  correct: '做对了',
  partial: '部分对',
  partial_unknown: '部分对',
  incorrect: '做错了',
  unsupported: '这题判不准',
};

const CLAIM_WORDS = { again: '再练', hard: '模糊', good: '会了' } as const;

export function attemptFacts(evidence: AttemptEvidence | null): readonly AttemptFact[] {
  if (!evidence) return [];
  const rating = evidence.self_claim?.rating;
  return [
    ...(evidence.assistance ? [{ label: '提示', value: helpWords(evidence.assistance) }] : []),
    ...(evidence.verdict
      ? [{ label: '判分', value: VERDICT_WORDS[evidence.verdict.outcome] }]
      : []),
    ...(rating ? [{ label: '你说', value: CLAIM_WORDS[rating] }] : []),
  ];
}
