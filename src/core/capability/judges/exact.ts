import { z } from 'zod';
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import {
  extractAnswerHead,
  extractFinalAnswer,
  isProcessLikeAnswer,
} from '@/core/schema/judge-routing';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

const ExactJudgeQuestion = z.object({
  reference: z.string().min(1),
  // Option texts resolve letters and text both ways for choice questions. Null is
  // normalized to [] so a raw DB row still judges as plain exact, not unsupported.
  choices_md: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
});

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'exact',
  kind: 'judge',
  version: VERSION,
  input_schema: 'ExactJudgeInput { reference: string; choices_md?: string[] | null }',
  output_schema: 'JudgeResultV2',
  cost_class: 'local',
  latency_class: 'sync',
  stability: 'stable',
};

const CAPABILITY_REF = { id: manifest.id, version: VERSION };

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

function unsupportedResult(input: JudgeRunInput, issue: string): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'correctness',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md: `exact judge input unsupported: ${issue}`,
    evidence_json: {
      validation_error: issue,
      question: input.question,
    },
  };
}

function run(input: JudgeRunInput): JudgeResultV2T {
  const parsed = ExactJudgeQuestion.safeParse(input.question);
  if (!parsed.success) {
    return unsupportedResult(
      input,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const question = parsed.data;
  const normalizedReference = normalize(question.reference);
  const normalizedAnswer = normalize(input.answer.content);

  // Resolve both sides to choice indices when possible (letters vs option text, in
  // either direction); otherwise fall back to plain text equality.
  const choices = question.choices_md;
  const resolveChoiceIndices = (value: string): number[] | null => {
    if (choices.length === 0) return null;
    const t = value.normalize('NFKC').trim();
    if (t.length === 0) return null;
    const tLower = t.toLowerCase();

    // Text equality first, so an option like 'True'/'a + b' is not parsed as a letter.
    const exact = choices.findIndex((c) => normalize(c) === tLower);
    if (exact !== -1) return [exact];

    // Pure letter strings; out-of-range indices fall through to prefix parsing.
    const lettersOnly = t.toUpperCase().replace(/[\s,，、和与]/g, '');
    if (/^[A-Z]+$/.test(lettersOnly)) {
      const idx = [...new Set(lettersOnly.split('').map((c) => c.charCodeAt(0) - 65))].sort(
        (a, b) => a - b,
      );
      if (idx.length > 0 && idx.every((i) => i < choices.length)) return idx;
    }

    // Leading-letter prefix, including the parenthesised "（C）…" form, accepted only
    // when followed by a separator so a bare word is never read as an index.
    const prefix = t
      .toUpperCase()
      .match(/^[（(]([A-Z]{1,4})(?:[\s.．。、,，:：)）]|$)|^([A-Z])(?:[\s.．。、,，:：)）]|$)/);
    if (prefix) {
      const indices = [...(prefix[1] ?? prefix[2])].map((ch) => ch.charCodeAt(0) - 65);
      if (indices.every((i) => i < choices.length)) return indices;
    }

    return null;
  };
  // Source references and learner answers may carry an explanation tail; judge the
  // extracted answer head only.
  const answerHead = extractAnswerHead(input.answer.content);
  const referenceHead = extractAnswerHead(question.reference);
  const answerIdx = resolveChoiceIndices(answerHead);
  const referenceIdx = resolveChoiceIndices(referenceHead);
  const choiceMatch =
    answerIdx !== null &&
    referenceIdx !== null &&
    answerIdx.length === referenceIdx.length &&
    answerIdx.every((v, i) => v === referenceIdx[i]);

  const match = choiceMatch || normalize(answerHead) === normalize(referenceHead);

  // Record how the match was decided and the indices; otherwise differing raw texts
  // make the stored evidence look self-contradictory.
  const matchType: 'choice_index' | 'text' = choiceMatch ? 'choice_index' : 'text';
  const choiceEvidence = {
    match_type: matchType,
    answer_choice_indices: answerIdx,
    reference_choice_indices: referenceIdx,
  };
  // Record extracted heads when a tail was stripped, for the same reason.
  const headEvidence = {
    ...(answerHead !== input.answer.content.normalize('NFKC').trim()
      ? { answer_head: answerHead }
      : {}),
    ...(referenceHead !== question.reference.normalize('NFKC').trim()
      ? { reference_answer_head: referenceHead }
      : {}),
  };

  if (match) {
    return {
      score: 1,
      score_meaning: 'correctness',
      coarse_outcome: 'correct',
      confidence: 1,
      capability_ref: CAPABILITY_REF,
      feedback_md: `正确答案：${question.reference}。`,
      evidence_json: {
        match,
        normalized_answer: normalizedAnswer,
        normalized_reference: normalizedReference,
        ...choiceEvidence,
        ...headEvidence,
      },
    };
  }

  // After a head miss, try the explicit final answer ("推导…S5=11" vs "11"). If it
  // cannot be resolved, report unsupported rather than pretend a zero score.
  const finalAnswer = extractFinalAnswer(input.answer.content);
  if (finalAnswer.kind === 'found') {
    const finalHit = finalAnswer.values.some(
      (candidate) => normalize(candidate) === normalize(referenceHead),
    );
    if (finalHit) {
      return {
        score: 1,
        score_meaning: 'correctness',
        coarse_outcome: 'correct',
        confidence: 1,
        capability_ref: CAPABILITY_REF,
        feedback_md: `正确答案：${question.reference}。`,
        evidence_json: {
          match: true,
          normalized_answer: normalizedAnswer,
          normalized_reference: normalizedReference,
          final_answer: { value: finalAnswer.values[0] ?? '', marker: finalAnswer.marker },
          ...choiceEvidence,
          ...headEvidence,
        },
      };
    }
  }
  if (isProcessLikeAnswer(input.answer.content)) {
    return {
      score: null,
      score_meaning: 'correctness',
      coarse_outcome: 'unsupported',
      confidence: 0,
      capability_ref: CAPABILITY_REF,
      feedback_md:
        finalAnswer.kind === 'found'
          ? 'extracted final answer does not match the reference — equivalence beyond the exact comparator contract'
          : finalAnswer.kind === 'ambiguous'
            ? `conflicting explicit final answers (${finalAnswer.candidates.join(' / ')}) — exact comparator cannot adjudicate`
            : 'worked/process answer carries no unambiguous final answer — beyond the exact comparator contract',
      evidence_json: {
        match: false,
        reason: 'process_answer_unresolvable',
        normalized_answer: normalizedAnswer,
        normalized_reference: normalizedReference,
        ...(finalAnswer.kind === 'found'
          ? { final_answer: { value: finalAnswer.values[0] ?? '', marker: finalAnswer.marker } }
          : {}),
        ...(finalAnswer.kind === 'ambiguous'
          ? { final_answer_candidates: finalAnswer.candidates }
          : {}),
        ...choiceEvidence,
        ...headEvidence,
      },
    };
  }

  return {
    score: 0,
    score_meaning: 'correctness',
    coarse_outcome: 'incorrect',
    confidence: 1,
    capability_ref: CAPABILITY_REF,
    feedback_md: `参考答案：${question.reference}。你的答案：${input.answer.content}。`,
    evidence_json: {
      match,
      normalized_answer: normalizedAnswer,
      normalized_reference: normalizedReference,
      ...(finalAnswer.kind === 'found'
        ? { final_answer: { value: finalAnswer.values[0] ?? '', marker: finalAnswer.marker } }
        : {}),
      ...choiceEvidence,
      ...headEvidence,
    },
  };
}

export const exactJudgeCapability: JudgeCapabilityRunner = { manifest, run };
