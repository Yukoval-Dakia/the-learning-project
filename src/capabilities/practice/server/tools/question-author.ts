import { and, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { QuestionAuthorIntentSchema } from '@/ai/task-intents';
import {
  type QuestionAnswerAnchorT,
  validateSourceLocatorBytes,
} from '@/core/schema/question-generation-grounding';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import type { ToolContext } from '@/kernel/tools/types';
import { resolveSubjectProfile } from '@/subjects/profile';
import { normalizeToCanonicalKind } from '@/subjects/question-kind';

// Candidate-only generation still consumes this preparation until its cutover.
const DEFAULT_MATERIAL_QUESTION_KIND = 'short_answer';

export interface QuestionAuthorSeed {
  seed_mode: 'knowledge' | 'material';
  knowledge_ids: string[];
  /** Free-text type request: recognized kind labels constrain the author
   *  verbatim; anything else reaches it as a descriptive hint only. */
  requested_kind?: string;
  difficulty?: number;
  /** REQUIRED for seed_mode='material' (the task has no fetch tool — critic #5). */
  material_body_md?: string;
  /** REQUIRED source-grounded answer evidence for the material production path. */
  material_answer_anchor?: {
    canonical_answer: QuestionAnswerAnchorT['canonical_answer'];
    locator: QuestionAnswerAnchorT['source']['locator'];
  };
  /** Provenance-only metadata; never fetched (single-shot task, no Tavily). */
  material_url?: string;
  material_title?: string;
}

async function buildQuestionAuthorPreparation(db: Db, seed: QuestionAuthorSeed) {
  if (seed.seed_mode === 'material' && !seed.material_body_md?.trim()) {
    throw new Error("question_author seed_mode 'material' requires material_body_md");
  }

  if (seed.seed_mode === 'material' && !seed.material_answer_anchor) {
    throw new Error("question_author seed_mode 'material' requires material_answer_anchor");
  }

  if (seed.seed_mode === 'material' && seed.material_answer_anchor && seed.material_body_md) {
    const locator = seed.material_answer_anchor.locator;
    if (locator.kind !== 'text_span') {
      throw new Error(
        `question_author material locator '${locator.kind}' has no authoritative page content`,
      );
    }
    // Inline material is its own authoritative source; validate the locator's
    // half-open UTF-8 byte range via the shared grounding authority.
    validateSourceLocatorBytes(locator, new TextEncoder().encode(seed.material_body_md));
  }

  const wanted = [...new Set(seed.knowledge_ids)];
  const nodes = wanted.length
    ? await db
        .select({ id: knowledge.id, name: knowledge.name })
        .from(knowledge)
        .where(and(inArray(knowledge.id, wanted), isNull(knowledge.archived_at)))
    : [];
  if (nodes.length === 0) return null;

  const validIds = nodes.map((node) => node.id);
  const validIdSet = new Set(validIds);
  const firstValidId = wanted.find((id) => validIdSet.has(id)) ?? validIds[0];
  let effectiveDomain: string | null = null;
  try {
    effectiveDomain = await getEffectiveDomain(db, firstValidId);
  } catch {
    effectiveDomain = null;
  }
  // requested_kind splits two ways at plan-creation time. A label the kind
  // vocabulary recognizes (canonical or profile/skill, folded to canonical)
  // stays a HARD constraint — it reaches the prompt as requested_kind and, on
  // the material path, the persisted plan, so the verifier compares
  // like-for-like. Any other non-empty label is the caller's free-text wording
  // (「计算题」, a whole sentence): it reaches the author as requested_kind_hint
  // only — an input to judgement, not a gate — and the author resolves a real
  // structural kind plus a compatible judge route itself. Passing free text as
  // requested_kind made the sub-model echo it verbatim as kind and pick an
  // exact route, which the judge contract rejects (unknown kinds classify
  // semantic), killing solvable drafts.
  const requestedLabel = seed.requested_kind?.trim() ?? '';
  const canonicalRequestedKind = requestedLabel ? normalizeToCanonicalKind(requestedLabel) : null;
  const requestedKindHint =
    canonicalRequestedKind === null && requestedLabel.length > 0 ? requestedLabel : null;
  // The material path persists a plan whose requested_kind is veto-compared by
  // implied answer class, so an omitted kind still defaults to the canonical
  // material default. A free-text hint pins nothing: the prompt gets no
  // requested_kind and the plan records the resolved kind instead (below) —
  // persisting the raw label would veto valid exact/steps-class results.
  const effectiveKind =
    seed.seed_mode === 'material'
      ? requestedKindHint
        ? null
        : (canonicalRequestedKind ?? DEFAULT_MATERIAL_QUESTION_KIND)
      : canonicalRequestedKind;

  return {
    input: {
      seed_mode: seed.seed_mode,
      knowledge_context: nodes.map((node) => ({ id: node.id, name: node.name })),
      ...(effectiveKind ? { requested_kind: effectiveKind } : {}),
      ...(requestedKindHint ? { requested_kind_hint: requestedKindHint } : {}),
      ...(seed.difficulty !== undefined ? { requested_difficulty: seed.difficulty } : {}),
      ...(seed.material_body_md
        ? {
            material: {
              body_md: seed.material_body_md,
              ...(seed.material_title ? { title: seed.material_title } : {}),
            },
          }
        : {}),
    },
    ctx: { subjectProfile: resolveSubjectProfile(effectiveDomain) },
    validIds,
    validIdSet,
    effectiveKind,
    requestedKindHint,
  };
}

export async function prepareQuestionAuthorTask(
  ctx: Pick<ToolContext, 'db'>,
  seed: z.infer<typeof QuestionAuthorIntentSchema>,
) {
  const prepared = await buildQuestionAuthorPreparation(ctx.db, seed);
  if (!prepared) throw new Error('QuestionAuthorTask knowledge not found');
  return { input: prepared.input, ctx: prepared.ctx };
}
