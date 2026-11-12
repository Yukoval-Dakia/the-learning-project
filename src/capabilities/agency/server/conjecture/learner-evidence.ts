// Resolves intervention evidence refs into the same bounded wrong-answer quotes
// the probe author already loads. The model sees at most the probe sample cap;
// every resolved prompt still rejects a transfer that repeats that question.
// Photo bytes stay out; the author task is text-only.

import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { PROBE_RESULT_ACTION } from '@/core/schema/conjecture';
import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';
import type { FailureAttempt } from '@/kernel/read-models/failure-attempts';
import { getFailureAttemptById } from '@/kernel/read-models/failure-attempts';
import type {
  LearnerEvidenceBlock,
  LearnerEvidenceCause,
  LearnerEvidenceJudgement,
  LearnerEvidenceLoad,
  LearnerEvidenceRef,
} from '@/kernel/read-models/learner-evidence';
import type { ConjectureEvidenceSample, ConjectureFailureAttempt } from './evidence';
import {
  CONJECTURE_EVIDENCE_SAMPLES_PER_CELL,
  loadEvidenceSampleBatch,
} from './evidence-enrichment';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN, wrapTruncatedLearnerText } from './untrusted-text';

type DbLike = Db | Tx;

const ProbeJudgement = z
  .object({
    answer_result: z.enum(['correct', 'incorrect', 'ungradable']),
    target_error_match: z.enum(['matched', 'not_matched', 'ambiguous']),
  })
  .passthrough();

const ProbeResultPayload = z
  .object({
    outcome: z.union([z.literal(0), z.literal(1), z.null()]).optional(),
    answer_md: z.string().nullable().optional(),
    answer_image_refs: z.array(z.string()).nullish(),
    response_judgement: ProbeJudgement.nullish(),
  })
  .passthrough();

type ProbeResultPayloadT = z.infer<typeof ProbeResultPayload>;

interface QuotedProbe {
  questionId: string;
  payload: ProbeResultPayloadT;
}

interface ChunkItem {
  block: LearnerEvidenceBlock | null;
  prompts: string[];
}

function quotedLearnerText(value: string | null): string | null {
  if (value === null) return null;
  const inner =
    value.startsWith(UNTRUSTED_OPEN) && value.endsWith(UNTRUSTED_CLOSE)
      ? value.slice(UNTRUSTED_OPEN.length, value.length - UNTRUSTED_CLOSE.length)
      : value;
  return inner.length > 0 ? inner : null;
}

function missedPrompts(sample: ConjectureEvidenceSample): string[] {
  return [sample.question_prompt_md, sample.parent_question_prompt_md].flatMap((value) => {
    const text = quotedLearnerText(value);
    return text === null ? [] : [text];
  });
}

function toConjectureFailure(failure: FailureAttempt): ConjectureFailureAttempt {
  return {
    attempt_event_id: failure.attempt_event_id,
    question_id: failure.question_id,
    answer_md: failure.answer_md,
    answer_image_refs: failure.answer_image_refs,
    referenced_knowledge_ids: failure.referenced_knowledge_ids,
    question_snapshot: failure.question_snapshot,
    created_at: failure.created_at,
    ...(failure.judge
      ? { judge: { cause: failure.judge.cause, created_at: failure.judge.created_at } }
      : {}),
    ...(failure.original_judge
      ? {
          original_judge: {
            cause: failure.original_judge.cause,
            created_at: failure.original_judge.created_at,
          },
        }
      : {}),
    ...(failure.user_cause
      ? {
          user_cause: {
            primary_category: failure.user_cause.primary_category,
            user_notes: failure.user_cause.user_notes,
            created_at: failure.user_cause.created_at,
          },
        }
      : {}),
  };
}

function causeOf(sample: ConjectureEvidenceSample): LearnerEvidenceCause | null {
  if (
    sample.cause_category === null &&
    sample.cause_source === null &&
    sample.cause_attribution_md === null
  ) {
    return null;
  }
  return {
    category: sample.cause_category,
    source: sample.cause_source,
    attribution_md: sample.cause_attribution_md,
  };
}

function failureBlock(
  ref: LearnerEvidenceRef,
  sample: ConjectureEvidenceSample,
  coarseOutcome: string | null,
): ChunkItem {
  const judgement: LearnerEvidenceJudgement = {
    result: 'incorrect',
    coarse_outcome: coarseOutcome,
    target_error_match: null,
  };
  return {
    block: {
      ref: { kind: ref.kind, id: ref.id },
      source: 'failure_attempt',
      question_id: sample.question_id,
      question_prompt_md: sample.question_prompt_md,
      parent_question_prompt_md: sample.parent_question_prompt_md,
      answer_md: sample.answer_md,
      answer_image_count: sample.answer_image_refs.length,
      judgement,
      cause: causeOf(sample),
    },
    prompts: missedPrompts(sample),
  };
}

function isWrongProbe(payload: ProbeResultPayloadT): boolean {
  if (payload.outcome === 1 || payload.response_judgement?.answer_result === 'correct') {
    return false;
  }
  return payload.outcome === 0 || payload.response_judgement?.answer_result === 'incorrect';
}

function probeJudgement(payload: ProbeResultPayloadT): LearnerEvidenceJudgement {
  const judgement = payload.response_judgement;
  return {
    result: judgement?.answer_result ?? 'incorrect',
    coarse_outcome: null,
    target_error_match: judgement?.target_error_match ?? null,
  };
}

async function readCoarseOutcomes(
  db: DbLike,
  judgeEventIds: string[],
): Promise<Map<string, string>> {
  if (judgeEventIds.length === 0) return new Map();
  const rows = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(inArray(event.id, judgeEventIds));
  const outcomes = new Map<string, string>();
  for (const row of rows) {
    const coarse = z.object({ coarse_outcome: z.string() }).passthrough().safeParse(row.payload);
    if (coarse.success) outcomes.set(row.id, coarse.data.coarse_outcome);
  }
  return outcomes;
}

async function readWrongProbes(db: DbLike, eventIds: string[]): Promise<Map<string, QuotedProbe>> {
  if (eventIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: event.id,
      action: event.action,
      subject_id: event.subject_id,
      payload: event.payload,
    })
    .from(event)
    .where(inArray(event.id, eventIds));
  const probes = new Map<string, QuotedProbe>();
  for (const row of rows) {
    if (row.action !== PROBE_RESULT_ACTION) continue;
    const payload = ProbeResultPayload.safeParse(row.payload);
    if (!payload.success || !isWrongProbe(payload.data)) continue;
    probes.set(row.id, { questionId: row.subject_id, payload: payload.data });
  }
  return probes;
}

async function readPrompts(
  db: DbLike,
  questionIds: string[],
): Promise<Map<string, { prompt: string; parent: string | null }>> {
  if (questionIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: question.id,
      prompt_md: question.prompt_md,
      parent_question_id: question.parent_question_id,
    })
    .from(question)
    .where(inArray(question.id, questionIds));
  const parentIds = [
    ...new Set(rows.flatMap((row) => (row.parent_question_id ? [row.parent_question_id] : []))),
  ];
  const parentRows =
    parentIds.length === 0
      ? []
      : await db
          .select({ id: question.id, prompt_md: question.prompt_md })
          .from(question)
          .where(inArray(question.id, parentIds));
  const parentPrompt = new Map(parentRows.map((row) => [row.id, row.prompt_md]));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        prompt: row.prompt_md,
        parent: row.parent_question_id ? (parentPrompt.get(row.parent_question_id) ?? null) : null,
      },
    ]),
  );
}

function probeBlock(
  ref: LearnerEvidenceRef,
  probe: QuotedProbe,
  prompts: Map<string, { prompt: string; parent: string | null }>,
): ChunkItem {
  const stored = prompts.get(probe.questionId);
  const questionPrompt = stored?.prompt ?? null;
  const parentPrompt = stored?.parent ?? null;
  const raw = [questionPrompt, parentPrompt].flatMap((value) =>
    value && value.length > 0 ? [value] : [],
  );
  return {
    block: {
      ref: { kind: ref.kind, id: ref.id },
      source: 'probe_result',
      question_id: probe.questionId,
      question_prompt_md: wrapTruncatedLearnerText(questionPrompt),
      parent_question_prompt_md: wrapTruncatedLearnerText(parentPrompt),
      answer_md: wrapTruncatedLearnerText(probe.payload.answer_md ?? null),
      answer_image_count: probe.payload.answer_image_refs?.length ?? 0,
      judgement: probeJudgement(probe.payload),
      cause: null,
    },
    prompts: raw,
  };
}

async function resolveChunk(db: DbLike, refs: readonly LearnerEvidenceRef[]): Promise<ChunkItem[]> {
  const attempts = await Promise.all(refs.map((ref) => getFailureAttemptById(db, ref.id)));
  const failures = attempts.flatMap((attempt) => (attempt ? [toConjectureFailure(attempt)] : []));
  const samples = await loadEvidenceSampleBatch(db, failures, new Map());
  const coarse = await readCoarseOutcomes(
    db,
    attempts.flatMap((attempt) => (attempt?.judge ? [attempt.judge.judge_event_id] : [])),
  );
  const probeIds = refs.flatMap((ref, index) => (attempts[index] ? [] : [ref.id]));
  const probes = await readWrongProbes(db, probeIds);
  const prompts = await readPrompts(
    db,
    [...probes.values()].map((probe) => probe.questionId),
  );
  return refs.map((ref, index) => {
    const attempt = attempts[index];
    if (attempt) {
      const sample = samples.get(attempt.attempt_event_id);
      if (!sample) return { block: null, prompts: [] };
      return failureBlock(
        ref,
        sample,
        attempt.judge ? (coarse.get(attempt.judge.judge_event_id) ?? null) : null,
      );
    }
    const probe = probes.get(ref.id);
    if (!probe) return { block: null, prompts: [] };
    return probeBlock(ref, probe, prompts);
  });
}

/** Quote wrong answers behind `refs`, in ref order, up to the probe sample cap. */
export async function loadLearnerEvidenceBlocks(
  db: DbLike,
  refs: readonly LearnerEvidenceRef[],
): Promise<LearnerEvidenceLoad> {
  const eventRefs = refs.filter((ref) => ref.kind === 'event');
  const blocks: LearnerEvidenceBlock[] = [];
  const missed = new Set<string>();
  let unresolved = refs.length - eventRefs.length;
  let omitted = 0;
  let index = 0;
  while (index < eventRefs.length) {
    const chunk = eventRefs.slice(index, index + CONJECTURE_EVIDENCE_SAMPLES_PER_CELL);
    index += chunk.length;
    const resolved = await resolveChunk(db, chunk);
    for (const item of resolved) {
      if (!item.block) {
        unresolved += 1;
        continue;
      }
      for (const prompt of item.prompts) missed.add(prompt);
      if (blocks.length < CONJECTURE_EVIDENCE_SAMPLES_PER_CELL) blocks.push(item.block);
      else omitted += 1;
    }
  }
  return {
    blocks,
    missed_prompt_md: [...missed],
    unresolved_ref_count: unresolved,
    omitted_ref_count: omitted,
  };
}
