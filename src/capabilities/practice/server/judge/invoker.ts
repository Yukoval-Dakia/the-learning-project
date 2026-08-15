import { type Provider, type TaskKind, tasks } from '@/ai/registry';
import { isAiTaskKind } from '@/ai/task-prompts';
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
import { zodToJsonSchemaOutputFormat } from '@/server/ai/output-format';
import type { TaskTextResult } from '@/server/ai/provenance';
import {
  crossoverModelForProvider,
  isKnownProvider,
  isProviderImplemented,
} from '@/server/ai/providers';
import { SubjectProfileSchema } from '@/subjects/profile';
import { z } from 'zod';
import type { JudgeKind } from '.';
// F0 (PR #309 round-3) — resolver now lives in the dependency-light leaf.
import { persistJudgeRunDigests } from './execution-provenance-resolve';
import {
  JUDGE_PROMPT_TEMPLATE_REVISION,
  judgePromptFingerprint,
  sha256Canonical,
  taskInputHash,
} from './judge-execution-provenance';
import { narrowQuestionToPart } from './narrow-part';
import {
  FUTURE_JUDGE_ROUTES,
  type JudgeAnswerParams,
  RUNNABLE_ROUTES,
  buildLocalJudgeQuestion,
  defaultRunTaskFn,
  runSemanticJudge,
  unsupportedResult,
} from './question-contract';
import { resolveQuestionJudgeRoute } from './route-resolve';

const unitDimensionOutputSchema = tasks.UnitDimensionFallback.structuredOutputSchema;
const UNIT_DIMENSION_OUTPUT_FORMAT = unitDimensionOutputSchema
  ? zodToJsonSchemaOutputFormat(unitDimensionOutputSchema)
  : undefined;

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
  // YUK-573 (MF6) — optional image fetcher threaded to the vision dispatches.
  imageFetchFn: z
    .custom<NonNullable<JudgeAnswerParams['imageFetchFn']>>((value) => typeof value === 'function')
    .optional(),
  // YUK-212 + YUK-484(B) — optional StructuredQuestion.id of the sub-node to
  // grade. Narrowed in invoke() before route resolution + dispatch; absent /
  // unresolvable → whole-row (back-compat). NOT a question_part id.
  part_ref: z.string().nullable().optional(),
  // YUK-594 (D7/D9) — durable-run scoped runner overrides (judge_run handler only).
  // #14 — `providerOverride` is typed `Provider` on JudgeAnswerParams.durable
  // (question-contract.ts), so a bare `z.string()` here let an arbitrary name
  // ("invalid-provider") pass the validation boundary and only fail downstream at
  // `resolveTaskProvider`.
  //
  // W5 #TuwGv — `isKnownProvider` ALONE does not deliver that promise: it is
  // `Object.hasOwn(PROVIDERS, name)`, which is true for the reserved-but-unwired names
  // (`openrouter` / `gateway` / `openai`), so those passed the boundary and threw later at
  // `resolveTaskProvider`'s "reserved but not implemented" guard — exactly the downstream
  // failure this validation exists to prevent. Both predicates are needed, and together they
  // match the discipline `judgeFallbackProvider` already applies on the config side. Still
  // composed from the single-source predicates rather than a re-listed union, so a newly
  // wired provider cannot drift a second hard-coded copy out of sync.
  durable: z
    .object({
      providerOverride: z
        .custom<Provider>(
          (value) =>
            typeof value === 'string' && isKnownProvider(value) && isProviderImplemented(value),
          { message: 'providerOverride must be a known, implemented provider' },
        )
        .optional(),
    })
    .optional(),
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
  // YUK-589 (K1) — was a model invocation ATTEMPTED for this verdict? True iff
  // the observed runTaskFn wrapper was actually called (a route that runs the
  // LLM). Distinguishes an accelerator-resolved / deterministic verdict (false →
  // `deterministic`) from a model-backed route whose call ran (true) — the latter
  // stamps `invoked` when execution is present, else `historical_unknown`. This
  // is the honest signal the downstream stamp keys on, NOT route membership: a
  // unit_dimension slot resolved by the local accelerator (no runTaskFn call) is
  // deterministic even though its route is in the model-backed set.
  modelAttempted: z.boolean(),
  task_run_id: z.string().min(1).optional(),
  execution: z
    .object({
      task_kind: z.string().min(1),
      task_run_id: z.string().min(1).optional(),
      input_hash: z.string().regex(/^[a-f0-9]{64}$/),
      prompt_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      prompt_template_revision: z.string().min(1),
    })
    .optional(),
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
    let taskRunId: string | undefined;
    let execution: JudgeInvokerOutput['execution'];
    // YUK-589 (K1) — flipped true the moment the observed runner is actually
    // called, so a route that never runs the LLM (accelerator-resolved
    // unit_dimension, exact/keyword) stays `deterministic` downstream instead of
    // being mis-stamped `historical_unknown` off route membership alone.
    let modelAttempted = false;
    // YUK-589 (K2) — the invoker's own default runner MUST preserve the sanctioned
    // `enableTransientRetry` opt-in the vision judges set (steps / multimodal_direct,
    // YUK-576). The shared makeRunTaskTextFn (defaultRunTaskFn) STRIPS it at the
    // untrusted-caller boundary; routing the default judge dispatch through it
    // silently disabled transient retry once invoke() began wrapping every runner.
    const configuredRunTaskFn =
      narrowed.runTaskFn ?? this.runTaskFn ?? judgeDefaultRunTaskFn(narrowed.db);
    const observedRunTaskFn: NonNullable<JudgeAnswerParams['runTaskFn']> = async (
      kind,
      taskInput,
      callCtx,
    ) => {
      // A model call is now in flight — mark it BEFORE the await so even a throwing
      // provider timeout (steps/semantic swallow into 'unsupported') still records
      // that the model WAS attempted (→ historical_unknown, never deterministic).
      modelAttempted = true;
      // YUK-594 (D7/D9) — durable runs override the runner ctx per-call: FORCE
      // enableTransientRetry:false (queue redelivery is the durable handler's only
      // transient layer, D7 single-transient-layer) and, on the fallback redelivery,
      // pin RunTaskCtx.override.provider so the call crosses to the fallback lane
      // (reuses the existing resolveTaskProvider seam — no new plumbing, D9). The
      // sync HTTP paths never set `durable`, so callCtx passes through UNCHANGED
      // (K2: the vision judges' sanctioned enableTransientRetry survives on them).
      // Cast note: `enableTransientRetry` is Omit'ted from the typed RunTaskCallCtx,
      // but judgeDefaultRunTaskFn forwards the ctx verbatim to runTask, so setting it
      // here reaches the runner — the exact mechanism the vision judges use to opt
      // IN (steps-judge.ts:297). We force it OFF here for the durable lane.
      //
      // W5 #TumMr — this DOES depend on the forwarding chain preserving the untyped key,
      // and `makeRunTaskFn`/`makeRunTaskTextFn` deliberately STRIP it (runner-fn.ts:18-19),
      // so a future refactor of judgeDefaultRunTaskFn onto those factories would silently
      // drop the forced-off. It would NOT be silent, though: `invoker-durable.test.ts`
      // mocks '@/server/ai/runner' and asserts `ctx.enableTransientRetry === false` at the
      // runTask boundary, so that refactor fails CI on the D7 single-transient-layer
      // invariant rather than degrading in production. Keep that test if this moves.
      const durable = narrowed.durable;
      let effectiveCtx = callCtx;
      if (durable) {
        const base = (callCtx && typeof callCtx === 'object' ? callCtx : {}) as Record<
          string,
          unknown
        >;
        effectiveCtx = {
          ...base,
          enableTransientRetry: false,
          // W5 #TurRP — crossing lanes must pin the MODEL too, not just the provider.
          // `resolveTaskProvider` layers the two independently
          // (`override?.model ?? envOverride?.model ?? subDefaultModel`), so a provider-only
          // override still inherits a global `AI_PROVIDER_MODEL` belonging to the lane we are
          // crossing AWAY from — posting e.g. a mimo model id to the subscription endpoint on
          // the one delivery whose entire purpose is to succeed. An explicit `model` wins the
          // precedence chain, so nothing leaks across the boundary. A model already present on
          // the incoming ctx (a deliberate per-call choice) is left alone.
          ...(durable.providerOverride
            ? {
                override: {
                  ...((base.override as Record<string, unknown> | undefined) ?? {}),
                  provider: durable.providerOverride,
                  model:
                    (base.override as { model?: string } | undefined)?.model ??
                    crossoverModelForProvider(durable.providerOverride, kind as TaskKind),
                },
              }
            : {}),
        } as typeof callCtx;
      }
      // Compute the judge result FIRST — it must NEVER be lost to a failure in the
      // advisory provenance metadata below.
      const taskResult = await configuredRunTaskFn(kind, taskInput, effectiveCtx);
      // YUK-589 (J4) — the metadata (taskInputHash / judgePromptFingerprint) is
      // best-effort provenance ONLY. A throw here (a BigInt / exotic value inside
      // taskInput, or an unknown task kind) must not crash the judge call. On any
      // failure leave `execution` undefined AND clear `taskRunId` so the persist
      // guard (`if (taskRunId && execution)`) is skipped → digests stay null → a
      // later supplied claim fails closed to `supplied_unverified` (never falsely
      // trusted) rather than corroborating against a bogus fingerprint.
      try {
        // Boundary-validate the untrusted kind string instead of an
        // `as AiTaskKind` cast-and-hope: an unknown kind would fingerprint against
        // a garbage system prompt (fail-open). isAiTaskKind narrows to AiTaskKind.
        if (!isAiTaskKind(kind)) {
          throw new Error(`unknown judge task kind '${kind}' — refusing to fingerprint`);
        }
        const provenance = {
          task_kind: kind,
          ...(taskResult.task_run_id ? { task_run_id: taskResult.task_run_id } : {}),
          input_hash: taskInputHash(taskInput),
          prompt_fingerprint: judgePromptFingerprint({
            taskKind: kind,
            taskInput,
            subjectProfile: narrowed.subjectProfile,
            judgeRoute: route,
          }),
          prompt_template_revision: JUDGE_PROMPT_TEMPLATE_REVISION,
        };
        taskRunId = taskResult.task_run_id;
        execution = provenance;
      } catch (err) {
        console.warn(
          `judge provenance metadata failed for ${narrowed.question.id}/${route} (kind '${kind}') — persisting no digests (fail-closed):`,
          err,
        );
        taskRunId = undefined;
        execution = undefined;
      }
      return taskResult;
    };
    const dispatched = await this.dispatch(route, {
      ...narrowed,
      runTaskFn: observedRunTaskFn,
    });

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

    // YUK-589 (High-sec) — bind the run to the prompt/result identity it actually
    // produced, so a later supplied-verified claim can be corroborated against
    // the persisted digests (not just an id/kind/input lookup). Best-effort:
    // failure leaves the digests null → a later supplied claim fails closed to
    // `supplied_unverified` rather than being falsely trusted.
    if (taskRunId && execution) {
      try {
        await persistJudgeRunDigests(narrowed.db, taskRunId, {
          prompt_fingerprint: execution.prompt_fingerprint,
          result_digest: sha256Canonical(result),
        });
      } catch (err) {
        console.warn(
          `judge run-digest persistence failed for ${narrowed.question.id}/${route} (run ${taskRunId}):`,
          err,
        );
        // YUK-589 (K3b) — the digests did NOT persist, so the invoker output must
        // not imply they exist. Clear execution + task_run_id (fail-closed): a
        // later supplied-verified claim then cannot be falsely corroborated
        // against digests the run never wrote. modelAttempted stays true (the
        // model DID run), so the stamp is `historical_unknown`, never a lie.
        taskRunId = undefined;
        execution = undefined;
      }
    }

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
    return JudgeInvokerOutputSchema.parse({
      route,
      result,
      telemetry,
      modelAttempted,
      ...(taskRunId ? { task_run_id: taskRunId } : {}),
      ...(execution ? { execution } : {}),
    });
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
      const { runStepsJudge } = await import('./steps-judge');
      return await runStepsJudge({
        db: input.db,
        question: input.question,
        answer_md: input.answer_md,
        student_image_refs: input.student_image_refs,
        subjectProfile: input.subjectProfile,
        // YUK-589 (K5) — shared re-wrap threads the active profile onto the ctx
        // while passing every other key (incl. enableTransientRetry) UNCHANGED.
        runTaskFn: threadSubjectProfileCtx(runTaskFn, input.subjectProfile),
        // YUK-573 (MF6) — additive threading; omitted → runner default.
        imageFetchFn: input.imageFetchFn,
      });
    }
    if (route === 'multimodal_direct') {
      const { runMultimodalDirectJudge } = await import('./multimodal-direct-judge');
      return await runMultimodalDirectJudge({
        db: input.db,
        question: input.question,
        answer_md: input.answer_md,
        student_image_refs: input.student_image_refs,
        subjectProfile: input.subjectProfile,
        // YUK-589 (K5) — same shared re-wrap as the steps dispatch above.
        runTaskFn: threadSubjectProfileCtx(runTaskFn, input.subjectProfile),
        // YUK-573 (MF6) — additive threading; omitted → runner default.
        imageFetchFn: input.imageFetchFn,
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
          runTaskFn: runTaskFn ?? defaultRunTaskFn(input.db),
          runTaskCtx: {
            subjectProfile: input.subjectProfile,
            outputFormat: UNIT_DIMENSION_OUTPUT_FORMAT,
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

// YUK-589 (K2) — the invoker's default judge task runner. Unlike the shared
// makeRunTaskTextFn (defaultRunTaskFn), it calls runTask with the call ctx
// PRESERVED — so the sanctioned `enableTransientRetry` opt-in the vision judges
// set (steps / multimodal_direct, YUK-576) survives to the runner instead of
// being stripped at the untrusted-caller boundary. task_run_id is carried
// through so provenance metadata is still captured on the default path.
function judgeDefaultRunTaskFn(db: Db): NonNullable<JudgeAnswerParams['runTaskFn']> {
  return async (kind, input, callCtx) => {
    const { runTask } = await import('@/server/ai/runner');
    const result = await runTask(kind, input, { ...(callCtx ?? {}), db });
    return {
      text: result.text,
      task_run_id: result.task_run_id,
      cost_usd: result.cost_usd,
      structured_output: result.structured_output,
    };
  };
}

// YUK-589 (K5) — the steps + multimodal_direct dispatches both thread the active
// SubjectProfile onto the call ctx before delegating to their runner. Extracted
// so the two identical re-wraps cannot drift. Passes every other ctx key through
// UNCHANGED (K2: enableTransientRetry must reach the runner).
function threadSubjectProfileCtx(
  fn: NonNullable<JudgeAnswerParams['runTaskFn']> | undefined,
  subjectProfile: JudgeAnswerParams['subjectProfile'],
): ((kind: string, taskInput: unknown, callCtx: unknown) => Promise<TaskTextResult>) | undefined {
  if (!fn) return undefined;
  return (kind, taskInput, callCtx) =>
    fn(kind, taskInput, {
      ...(callCtx && typeof callCtx === 'object' ? callCtx : {}),
      subjectProfile,
    });
}

function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
