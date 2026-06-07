import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import { z } from 'zod';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

const ExactJudgeQuestion = z.object({
  reference: z.string().min(1),
  // YUK-260: option texts for choice questions. When present, both answer and
  // reference are resolved letter↔text before comparison so a letter submission
  // ("A" / "BC") matches a reference stored as option text (and vice versa).
  choices_md: z.array(z.string()).optional(),
});

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'exact',
  kind: 'judge',
  version: VERSION,
  input_schema: 'ExactJudgeInput { reference: string; choices_md?: string[] }',
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

  // YUK-260: choice questions — the student UI submits the letter ("A", multi
  // "BC") while the reference may store option TEXT (or vice versa, depending on
  // the sourcing line). Resolve both sides to choice indices when possible and
  // compare as sets; fall back to plain text equality so non-choice exact
  // judging is unchanged.
  const choices = question.choices_md ?? [];
  const resolveChoiceIndices = (value: string): number[] | null => {
    if (choices.length === 0) return null;
    const t = value.normalize('NFKC').trim();
    if (t.length === 0) return null;
    const lettersOnly = t.toUpperCase().replace(/[\s,，、和与]/g, '');
    if (/^[A-Z]+$/.test(lettersOnly)) {
      const idx = [...new Set(lettersOnly.split('').map((c) => c.charCodeAt(0) - 65))].sort(
        (a, b) => a - b,
      );
      if (idx.every((i) => i < choices.length)) return idx;
      return null;
    }
    const found = choices.findIndex((c) => normalize(c) === normalize(t));
    return found === -1 ? null : [found];
  };
  const answerIdx = resolveChoiceIndices(input.answer.content);
  const referenceIdx = resolveChoiceIndices(question.reference);
  const choiceMatch =
    answerIdx !== null &&
    referenceIdx !== null &&
    answerIdx.length === referenceIdx.length &&
    answerIdx.every((v, i) => v === referenceIdx[i]);

  const match = choiceMatch || normalizedAnswer === normalizedReference;

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
    },
  };
}

export const exactJudgeCapability: JudgeCapabilityRunner = { manifest, run };
