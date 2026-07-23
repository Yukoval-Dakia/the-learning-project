import { createHash } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';

import {
  QuestionAnswerAnchor,
  type QuestionAnswerAnchorT,
  QuestionGenerationPlan,
  type QuestionGenerationPlanT,
} from '@/core/schema/question-generation-grounding';
import type { Db, Tx } from '@/db/client';
import {
  question_answer_anchor,
  question_generation_binding,
  question_generation_plan,
} from '@/db/schema';
import { and, eq } from 'drizzle-orm';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export interface PrepareQuestionGenerationInput<T> {
  source: QuestionAnswerAnchorT['source'];
  canonicalAnswer: QuestionAnswerAnchorT['canonical_answer'];
  anchorProvenance: QuestionAnswerAnchorT['provenance'];
  demand: QuestionGenerationPlanT['demand'];
  knowledgeIds: string[];
  requestedKind: string;
  requestedAnswerClass: string;
  constraints: QuestionGenerationPlanT['constraints'];
  planProvenance: QuestionGenerationPlanT['provenance'];
  generate: (prepared: {
    anchor: QuestionAnswerAnchorT;
    plan: QuestionGenerationPlanT;
  }) => Promise<T>;
}

/** Persist anchor then plan before invoking generation. Invalid or failed writes abort first. */
export async function prepareQuestionGeneration<T>(
  db: Db,
  input: PrepareQuestionGenerationInput<T>,
): Promise<{ anchor: QuestionAnswerAnchorT; plan: QuestionGenerationPlanT; generated: T }> {
  const now = new Date();
  const anchorCore = {
    id: createId(),
    version: 1,
    schema_version: 1,
    source: input.source,
    canonical_answer: input.canonicalAnswer,
    provenance: input.anchorProvenance,
  };
  const anchor = QuestionAnswerAnchor.parse({
    ...anchorCore,
    content_hash: contentHash(anchorCore),
  });
  const planCore = {
    id: createId(),
    version: 1,
    schema_version: 1,
    demand: input.demand,
    knowledge_ids: input.knowledgeIds,
    requested_kind: input.requestedKind,
    requested_answer_class: input.requestedAnswerClass,
    answer_anchor: { id: anchor.id, version: anchor.version, content_hash: anchor.content_hash },
    constraints: input.constraints,
    provenance: input.planProvenance,
  };
  const plan = QuestionGenerationPlan.parse({ ...planCore, content_hash: contentHash(planCore) });

  await db.transaction(async (tx) => {
    await tx.insert(question_answer_anchor).values({
      id: anchor.id,
      version: anchor.version,
      schema_version: anchor.schema_version,
      source_artifact_kind: anchor.source.artifact_kind,
      source_artifact_id: anchor.source.artifact_id,
      source_version: anchor.source.version,
      source_content_hash: anchor.source.content_hash,
      source_locator: anchor.source.locator,
      canonical_answer: anchor.canonical_answer,
      provenance: anchor.provenance,
      content_hash: anchor.content_hash,
      created_at: now,
    });
    await tx.insert(question_generation_plan).values({
      id: plan.id,
      version: plan.version,
      schema_version: plan.schema_version,
      demand: plan.demand,
      knowledge_ids: plan.knowledge_ids,
      requested_kind: plan.requested_kind,
      requested_answer_class: plan.requested_answer_class,
      answer_anchor_id: plan.answer_anchor.id,
      answer_anchor_version: plan.answer_anchor.version,
      answer_anchor_hash: plan.answer_anchor.content_hash,
      constraints: plan.constraints,
      status: 'pending_generation',
      provenance: plan.provenance,
      content_hash: plan.content_hash,
      created_at: now,
    });
  });

  try {
    const generated = await input.generate({ anchor, plan });
    await db
      .update(question_generation_plan)
      .set({ status: 'generated' })
      .where(
        and(
          eq(question_generation_plan.id, plan.id),
          eq(question_generation_plan.version, plan.version),
          eq(question_generation_plan.content_hash, plan.content_hash),
        ),
      );
    return { anchor, plan, generated };
  } catch (error) {
    await db
      .update(question_generation_plan)
      .set({ status: 'failed' })
      .where(
        and(
          eq(question_generation_plan.id, plan.id),
          eq(question_generation_plan.version, plan.version),
          eq(question_generation_plan.content_hash, plan.content_hash),
        ),
      );
    throw error;
  }
}

const NO_COMPARATOR_POLICY = {
  id: 'none',
  version: 1,
  content_hash: 'sha256:no-proven-objective-comparator-v1',
} as const;

/** Persist the exact provenance tuple without claiming objective correctness. */
export async function bindGeneratedQuestion(
  db: Db | Tx,
  input: {
    questionId: string;
    plan: QuestionGenerationPlanT;
    anchor: QuestionAnswerAnchorT;
  },
) {
  if (
    input.plan.answer_anchor.id !== input.anchor.id ||
    input.plan.answer_anchor.version !== input.anchor.version ||
    input.plan.answer_anchor.content_hash !== input.anchor.content_hash
  ) {
    throw new Error('generation plan answer anchor does not match supplied anchor');
  }
  const [persistedPlan] = await db
    .select({ id: question_generation_plan.id })
    .from(question_generation_plan)
    .where(
      and(
        eq(question_generation_plan.id, input.plan.id),
        eq(question_generation_plan.version, input.plan.version),
        eq(question_generation_plan.content_hash, input.plan.content_hash),
        eq(question_generation_plan.answer_anchor_id, input.anchor.id),
        eq(question_generation_plan.answer_anchor_version, input.anchor.version),
        eq(question_generation_plan.answer_anchor_hash, input.anchor.content_hash),
        eq(question_generation_plan.status, 'generated'),
      ),
    )
    .limit(1);
  const [persistedAnchor] = await db
    .select({ id: question_answer_anchor.id })
    .from(question_answer_anchor)
    .where(
      and(
        eq(question_answer_anchor.id, input.anchor.id),
        eq(question_answer_anchor.version, input.anchor.version),
        eq(question_answer_anchor.content_hash, input.anchor.content_hash),
      ),
    )
    .limit(1);
  if (!persistedPlan || !persistedAnchor) {
    throw new Error('exact persisted generation plan and answer anchor tuple not found');
  }

  const binding = {
    plan: {
      id: input.plan.id,
      version: input.plan.version,
      content_hash: input.plan.content_hash,
    },
    answer_anchor: {
      id: input.anchor.id,
      version: input.anchor.version,
      content_hash: input.anchor.content_hash,
    },
    comparator_policy: NO_COMPARATOR_POLICY,
    validation_status: 'needs_review' as const,
    structural_status: 'no_veto' as const,
    objective_correctness: 'unverified' as const,
  };
  await db.insert(question_generation_binding).values({
    question_id: input.questionId,
    plan_id: binding.plan.id,
    plan_version: binding.plan.version,
    plan_hash: binding.plan.content_hash,
    answer_anchor_id: binding.answer_anchor.id,
    answer_anchor_version: binding.answer_anchor.version,
    answer_anchor_hash: binding.answer_anchor.content_hash,
    comparator_policy_id: binding.comparator_policy.id,
    comparator_policy_version: binding.comparator_policy.version,
    comparator_policy_hash: binding.comparator_policy.content_hash,
    validation_status: binding.validation_status,
    structural_status: binding.structural_status,
    objective_correctness: binding.objective_correctness,
    created_at: new Date(),
  });
  return binding;
}
