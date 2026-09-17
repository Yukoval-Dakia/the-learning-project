import { z } from 'zod';
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import { extractAnswerHead } from '@/core/schema/judge-routing';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';

const ExactJudgeQuestion = z.object({
  reference: z.string().min(1),
  // YUK-260: option texts for choice questions. When present, both answer and
  // reference are resolved letter↔text before comparison so a letter submission
  // ("A" / "BC") matches a reference stored as option text (and vice versa).
  // nullable: DB rows / JudgeQuestionRow carry choices_md as a nullable column;
  // a non-choice question may forward `choices_md: null`. Normalise null→[] via
  // the schema transform so passing a raw DB shape still judges as plain exact
  // (instead of degrading to "unsupported").
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

  // YUK-260: choice questions — the student UI submits the letter ("A", multi
  // "BC") while the reference may store option TEXT (or vice versa, depending on
  // the sourcing line). Resolve both sides to choice indices when possible and
  // compare as sets; fall back to plain text equality so non-choice exact
  // judging is unchanged.
  const choices = question.choices_md;
  const resolveChoiceIndices = (value: string): number[] | null => {
    if (choices.length === 0) return null;
    const t = value.normalize('NFKC').trim();
    if (t.length === 0) return null;
    // `t` is already NFKC + trim; normalize(t) would only re-add toLowerCase.
    const tLower = t.toLowerCase();

    // (1) Exact option-text equality first — so an option whose text happens to
    // be pure Latin letters (e.g. ['True','False'], or a math option 'a + b')
    // matches by text rather than being mis-parsed as a letter index.
    const exact = choices.findIndex((c) => normalize(c) === tLower);
    if (exact !== -1) return [exact];

    // (2) Pure letter string(s): "A" / "BC" / "B、C". Only accept when every
    // resolved index is in range; otherwise fall through to prefix parsing.
    const lettersOnly = t.toUpperCase().replace(/[\s,，、和与]/g, '');
    if (/^[A-Z]+$/.test(lettersOnly)) {
      const idx = [...new Set(lettersOnly.split('').map((c) => c.charCodeAt(0) - 65))].sort(
        (a, b) => a - b,
      );
      if (idx.length > 0 && idx.every((i) => i < choices.length)) return idx;
    }

    // (3) Leading-letter prefix: reference_md per the reading-comprehension skill
    // is "正确项字母 + 依据" (e.g. "C。原文依据…"), and choices_md options may carry
    // a label prefix ("A. 修八尺有余…"). YUK-1003: jyeoo/web-sourced references
    // also use the parenthesised form "（C）选项原文（+解析）" — allow an optional
    // full/half-width open paren before the letter. Parse the leading letter
    // when followed by a separator so 'C' answer ↔ "C。…" / "（C）…" reference
    // are judged equal.
    const prefix = t
      .toUpperCase()
      .match(/^[（(]([A-Z]{1,4})(?:[\s.．。、,，:：)）]|$)|^([A-Z])(?:[\s.．。、,，:：)）]|$)/);
    if (prefix) {
      const indices = [...(prefix[1] ?? prefix[2])].map((ch) => ch.charCodeAt(0) - 65);
      if (indices.every((i) => i < choices.length)) return indices;
    }

    return null;
  };
  // YUK-1003: web-sourced reference_md stores "<bare answer>\n\n解析：…" — the
  // judgeable surface is the extracted answer head. Same for the learner's
  // answer ("答：X" / trailing self-written explanation is still a correct
  // answer). resolveChoiceIndices and the text compare both run on heads.
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

  // YUK-260 evidence: when choiceMatch wins, normalized_answer / _reference can
  // legitimately differ (e.g. 'a' vs '选项一'), so record HOW the match was
  // decided plus the resolved indices, otherwise the stored evidence looks
  // self-contradictory. `match_type` is 'choice_index' only when the verdict was
  // actually driven by the index comparison; plain text equality stays 'text'.
  const matchType: 'choice_index' | 'text' = choiceMatch ? 'choice_index' : 'text';
  const choiceEvidence = {
    match_type: matchType,
    answer_choice_indices: answerIdx,
    reference_choice_indices: referenceIdx,
  };
  // YUK-1003: when either side embedded an explanation tail the compare ran on
  // extracted heads — record them, otherwise a stripped verdict reads
  // self-contradictory (normalized texts visibly differ).
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
      ...choiceEvidence,
      ...headEvidence,
    },
  };
}

export const exactJudgeCapability: JudgeCapabilityRunner = { manifest, run };
