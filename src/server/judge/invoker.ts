import { getDefaultRegistry } from '@/core/capability/judges';
import type { CapabilityRegistry } from '@/core/capability/registry';
import { JudgeKind as JudgeKindSchema } from '@/core/schema/business';
import {
  CapabilityRef,
  CoarseOutcome,
  JudgeResultV2,
  type JudgeResultV2T,
} from '@/core/schema/capability';
import type { Db } from '@/db/client';
import { SubjectProfileSchema } from '@/subjects/profile';
import { z } from 'zod';
import type { JudgeKind } from '../ai/judges';
import {
  FUTURE_JUDGE_ROUTES,
  type JudgeAnswerParams,
  RUNNABLE_ROUTES,
  buildLocalJudgeQuestion,
  defaultRunTaskFn,
  runSemanticJudge,
  unsupportedResult,
} from '../ai/judges/question-contract';
// F0 (PR #309 round-3) — resolver now lives in the dependency-light leaf.
import { narrowQuestionToPart } from './narrow-part';
import { resolveQuestionJudgeRoute } from './route-resolve';

export const JudgeInvokerQuestionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    prompt_md: z.string(),
    reference_md: z.string().nullable(),
    rubric_json: z.unknown(),
    choices_md: z.array(z.string()).nullable(),
    judge_kind_override: z.string().nullable(),
    knowledge_ids: z.array(z.string()).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    figures: z.array(z.unknown()).optional(),
    image_refs: z.array(z.string()).optional(),
    structured: z.unknown().nullable().optional(),
  })
  .passthrough();

export const JudgeInvokerInputSchema = z.object({
  db: z.custom<Db>((value) => value !== null && typeof value === 'object'),
  question: JudgeInvokerQuestionSchema,
  answer_md: z.string(),
  student_image_refs: z.array(z.string()).optional(),
  subjectProfile: SubjectProfileSchema,
  runTaskFn: z
    .custom<NonNullable<JudgeAnswerParams['runTaskFn']>>((value) => typeof value === 'function')
    .optional(),
  // YUK-212 + YUK-484(B) — optional StructuredQuestion.id of the sub-node to
  // grade. Narrowed in invoke() before route resolution + dispatch; absent /
  // unresolvable → whole-row (back-compat). NOT a question_part id.
  part_ref: z.string().nullable().optional(),
});

export const JudgeInvocationTelemetrySchema = z.object({
  route: JudgeKindSchema,
  capability_ref: CapabilityRef,
  coarse_outcome: CoarseOutcome,
  confidence: z.number().min(0).max(1),
  elapsed_ms: z.number().min(0),
  question_id: z.string().min(1),
  subject_id: z.string().min(1),
  // D6 (U4 L-stamp): the SubjectProfile.version active for this invocation.
  // Threaded into JudgeOnEvent.payload.profile_version downstream so judge
  // events carry the profile generation that produced them.
  profile_version: z.string().min(1),
});

export const JudgeInvokerOutputSchema = z.object({
  route: JudgeKindSchema,
  result: JudgeResultV2,
  telemetry: JudgeInvocationTelemetrySchema,
});

export type JudgeInvokerInput = z.infer<typeof JudgeInvokerInputSchema>;
export type JudgeInvocationTelemetry = z.infer<typeof JudgeInvocationTelemetrySchema>;
export type JudgeInvokerOutput = z.infer<typeof JudgeInvokerOutputSchema>;

export interface JudgeInvokerDeps {
  registry?: CapabilityRegistry;
  runTaskFn?: JudgeAnswerParams['runTaskFn'];
  onTelemetry?: (event: JudgeInvocationTelemetry) => void | Promise<void>;
}

export class JudgeInvoker {
  private readonly registry: CapabilityRegistry;
  private readonly runTaskFn?: JudgeAnswerParams['runTaskFn'];
  private readonly onTelemetry?: (event: JudgeInvocationTelemetry) => void | Promise<void>;

  constructor(deps: JudgeInvokerDeps = {}) {
    this.registry = deps.registry ?? getDefaultRegistry();
    this.runTaskFn = deps.runTaskFn;
    this.onTelemetry = deps.onTelemetry;
  }

  async invoke(input: JudgeAnswerParams): Promise<JudgeInvokerOutput> {
    // YUK-212 + YUK-484(B) — single chokepoint: narrow the question to the
    // addressed sub BEFORE route resolution + dispatch so every runner receives
    // the narrowed row through the existing plumbing (no per-runner edits).
    // narrowQuestionToPart returns the input row BY REFERENCE on a no-op (absent
    // / unresolvable part_ref, or no structured tree), so `narrowed === input`
    // and the whole-row path is byte-identical. Narrowing swaps text + structured
    // but NEVER identity: telemetry question_id stays the PARENT row id below.
    const question = narrowQuestionToPart(input.question, input.part_ref);
    const narrowed = question === input.question ? input : { ...input, question };

    const route = resolveQuestionJudgeRoute(narrowed.question, narrowed.subjectProfile);
    const startedAt = nowMs();
    const dispatched = await this.dispatch(route, narrowed);

    // D6 (U4 L-stamp, critic-R2 HIGH): pin capability_ref.version from the
    // active SubjectProfile.version, NOT the judge runners' module-level
    // '1.0.0' constants. Override on the RESULT object **before** the output
    // parse — /api/review/submit embeds `invoked.result.capability_ref` into the
    // review event payload (submit/route.ts:306), so a telemetry-only override
    // would still ship '1.0.0' into the event stream. The capability id stays
    // as the runner reported it; only the version is re-sourced.
    const pinnedCapabilityRef = {
      ...dispatched.capability_ref,
      version: narrowed.subjectProfile.version,
    };
    const result = { ...dispatched, capability_ref: pinnedCapabilityRef };

    const telemetry = JudgeInvocationTelemetrySchema.parse({
      route,
      // Same pinned ref on the telemetry side (attribution / analytics path).
      capability_ref: pinnedCapabilityRef,
      coarse_outcome: result.coarse_outcome,
      confidence: result.confidence,
      elapsed_ms: Math.max(0, nowMs() - startedAt),
      // Narrowing swaps text, not identity — the PARENT row id is the telemetry
      // anchor (narrowed.question.id === input.question.id on every path).
      question_id: narrowed.question.id,
      subject_id: narrowed.subjectProfile.id,
      profile_version: narrowed.subjectProfile.version,
    });

    await this.emitTelemetry(telemetry);
    return JudgeInvokerOutputSchema.parse({ route, result, telemetry });
  }

  private async dispatch(route: JudgeKind, input: JudgeAnswerParams): Promise<JudgeResultV2T> {
    if (!RUNNABLE_ROUTES.has(route)) {
      return unsupportedResult(route, `judge route '${route}' is not implemented`, {
        route,
        allowed_future_routes: FUTURE_JUDGE_ROUTES,
      });
    }

    const runner = this.registry.resolveJudge(route);
    if (!runner) {
      return unsupportedResult(route, `judge route '${route}' is not registered`, {
        route,
        registered_judges: this.registry.listJudges().map((manifest) => manifest.id),
      });
    }

    const runTaskFn = input.runTaskFn ?? this.runTaskFn;
    if (route === 'semantic') {
      return await runSemanticJudge({ ...input, runTaskFn });
    }
    if (route === 'steps') {
      const { runStepsJudge } = await import('../ai/judges/steps-judge');
      return await runStepsJudge({
        db: input.db,
        question: input.question,
        answer_md: input.answer_md,
        student_image_refs: input.student_image_refs,
        subjectProfile: input.subjectProfile,
        runTaskFn,
      });
    }
    if (route === 'multimodal_direct') {
      const { runMultimodalDirectJudge } = await import('../ai/judges/multimodal-direct-judge');
      return await runMultimodalDirectJudge({
        db: input.db,
        question: input.question,
        answer_md: input.answer_md,
        student_image_refs: input.student_image_refs,
        subjectProfile: input.subjectProfile,
        runTaskFn,
      });
    }
    if (route === 'unit_dimension') {
      const { runUnitDimensionJudge } = await import('@/core/capability/judges/unit_dimension');
      return await runUnitDimensionJudge(
        {
          question: buildLocalJudgeQuestion(input.question, route),
          answer: { content: input.answer_md },
        },
        {
          runTaskFn: runTaskFn ?? defaultRunTaskFn,
          runTaskCtx: {
            db: input.db,
            subjectProfile: input.subjectProfile,
          },
        },
      );
    }

    return await runner.run({
      question: buildLocalJudgeQuestion(input.question, route),
      answer: { content: input.answer_md },
    });
  }

  private async emitTelemetry(telemetry: JudgeInvocationTelemetry): Promise<void> {
    if (!this.onTelemetry) return;
    try {
      await this.onTelemetry(telemetry);
    } catch (err) {
      console.warn(
        `judge telemetry hook failed for ${telemetry.question_id}/${telemetry.route}:`,
        err,
      );
    }
  }
}

export function createDefaultJudgeInvoker(deps: JudgeInvokerDeps = {}): JudgeInvoker {
  return new JudgeInvoker(deps);
}

function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
