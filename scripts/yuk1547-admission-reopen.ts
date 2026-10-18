// Lead-only TEST operation. No automatic caller; no tests or Docker operations.
// Preflight sends ONE provider request outside paid_effect. --plan is a dry,
// read-only eligibility evaluation that freezes the void+reauthorization
// manifest. --execute replays that frozen plan inside ONE transaction per run:
// re-pend (generation bump) → void the explicitly named 'unknown' paid rows
// under the shared YUK-1567 void+successor protocol → admit the successor
// intent → enqueue the bound @3 job — all atomically committed. Old paid rows
// are never updated beyond the protocol's own void transition; the generic
// paid_effect_authorization rows carry reason/operator/basis and the exact
// successor delivery binding.
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Provider } from '@/ai/task-spec';
import {
  ADMISSION_FAMILY,
  type AdmissionJobData,
  admissionJobId,
  lockAdmissionGroup,
} from '@/capabilities/practice/server/admission/enqueue';
import { FrozenAdmissionInput } from '@/capabilities/practice/server/admission/receipt';
import { resolveQuestionAdmissionPolicyId } from '@/capabilities/practice/server/admission/run-admission';
import { QUESTION_ADMISSION_TASK_KIND } from '@/capabilities/practice/server/admission/solve';
import {
  QuestionAdmissionSolveInput,
  QuestionAdmissionSourceCrosscheckInput,
  QuestionAdmissionSourceCrosscheckOutput,
  parseQuestionAdmissionSolveModelOutput,
  questionAdmissionSolveTaskSpec,
} from '@/capabilities/practice/tasks/question-admission-solve';
import { getTaskSystemPrompt } from '@/capabilities/task-registry';
import { computePaidEffectIdentity } from '@/core/migration/paid-effect-protocol';
import { QUESTION_ADMISSION_POLICY_IDS } from '@/core/question-admission-policy';
import type { Db, Tx } from '@/db/client';
import { voidPaidEffectWithSuccessor } from '@/db/paid-effect-store';
import type { PublishQuestionGroupInput } from '@/kernel/records/assessment-publication';
import { zodToToolParametersSchema } from '@/kernel/zod-json-schema';
import { assertModelProfileCapabilityFit } from '@/server/ai/model-profiles';
import { nativePiModel } from '@/server/ai/pi-provider-catalog';
import {
  readProviderErrorEvidence,
  sanitizeProviderErrorText,
} from '@/server/ai/provider-error-evidence';
import { type TaskNativeReasoningParams, resolveTaskProvider } from '@/server/ai/providers';
import {
  STRUCTURED_OUTPUT_SUBMIT_TOOL,
  STRUCTURED_SUBMIT_REMINDER,
  classifySubmitTurn,
  resolveStructuredSubmitPolicy,
  structuredSubmitSystemSuffix,
  structuredSubmitWireFields,
} from '@/server/ai/structured-submit';
import { isToolParamContractError, repairToolArguments } from '@/server/ai/tool-param-contract';
import { resolveSubjectProfile } from '@/subjects/profile';

const submit = STRUCTURED_OUTPUT_SUBMIT_TOOL;
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ENQUEUE_SUBSCRIBER_ID = 'practice.question-admission-enqueue';
const PUBLISH_ACTION = 'experimental:assessment_publish';
const ACTOR_REF = 'owner:yuk1547-approved-reopen';

/**
 * Operator-authored void manifest: every 'unknown' blocker on each group must
 * be named explicitly (unit + input digest + the fence CAS token read at
 * manifest time). The successor unit is declared per group; the CLI freezes
 * the successor's full identity from the post-repend generation.
 */
const reopenManifestSchema = z.object({
  authorization_id: z.string().min(1),
  operator: z.string().min(1),
  basis: z.string().min(1),
  reason: z.string().min(1),
  groups: z
    .array(
      z.object({
        group_id: z.string().min(1),
        base_digest: digest,
        successor_unit: z.string().min(1),
        void: z
          .array(
            z.object({
              unit: z.string().min(1),
              input_digest: digest,
              expected_fence: z.number().int().nonnegative(),
            }),
          )
          .nonempty(),
      }),
    )
    .nonempty(),
});
type ReopenManifest = z.infer<typeof reopenManifestSchema>;
const hash = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
// YUK-1547 — the submit tool's parameters are the task output schema itself;
// the arguments object has `units` at top level, no {result: ...} envelope.
// YUK-1559 — the preflight sends the SAME wire contract piCustomTool mounts:
// the shared tool-parameters converter declares type:"object" at the root
// while keeping the object union in anyOf (a bare-anyOf root is a provider
// 400: 'schema must be a JSON Schema of type: "object"').
const schema = zodToToolParametersSchema(
  questionAdmissionSolveTaskSpec.definition.structuredOutputSchema,
  {
    io: 'input',
    reused: 'inline',
    target: 'draft-07',
  },
);

/** Ends the pool hydrateConfigFromDb may have opened inside routing(). */
let closeHydratedDb: (() => Promise<void>) | undefined;

interface ProbeRoute {
  solver: 'A' | 'B';
  provider: Provider;
  model: string;
  api: string;
  endpoint: string;
  apiKey: string;
  /** task.<kind>.reasoning resolved wire params — merged verbatim into the probe body. */
  nativeReasoning?: TaskNativeReasoningParams;
  /** Which config layer produced this route (env_pin / task_pair_priority / …). */
  selectionRule?: string;
  /** opencode-go requires x-opencode-session on every request. */
  sessionHeader?: boolean;
}

/**
 * Resolve the lane the admission solve job will actually take — the same
 * layering runTask sees (chat env pin > solver2 env > DB global > DB
 * task.<kind>.* > registry), read through resolveTaskProvider, NOT a local
 * provider/model literal. Solver B's QUESTION_ADMISSION_SOLVER2_* env is the
 * same override surface the job passes as `override`; unset = same resolved
 * config as Solver A. When DATABASE_URL is set the DB config layer MUST
 * hydrate — a failed read fails closed before any provider request/reopen
 * (env-only resolution could select a different model than the configured
 * pair). When DATABASE_URL is unset the face is env-only and says so in the
 * receipt's config_db_layer — it never claims TEST config was loaded.
 */
async function routing(): Promise<{
  routeA: ProbeRoute;
  routeB: ProbeRoute;
  solver2Provider: string | undefined;
  solver2Model: string | undefined;
  policy: string | undefined;
  config_db_layer: string;
  config_hydration?: { outcome: 'loaded' | 'unchanged'; epoch: number };
}> {
  const policyPin = process.env.QUESTION_ADMISSION_POLICY_ID?.trim();
  if (policyPin?.endsWith('@1') || policyPin?.endsWith('@2')) {
    throw new Error('Remove obsolete QUESTION_ADMISSION_POLICY_ID @1/@2 pin before deploy');
  }
  let configDbLayer = 'env-only(DATABASE_URL unset)';
  let configHydration: { outcome: 'loaded' | 'unchanged'; epoch: number } | undefined;
  if (process.env.DATABASE_URL) {
    const { db } = await import('@/db/client');
    try {
      const { hydrateConfigFromDb } = await import('@/server/config/hydrate');
      const report = await hydrateConfigFromDb(db);
      // Hydration is deliberately never-throws for app/worker refresh. A
      // failed DB read returns a report, so catch alone cannot guard a paid
      // preflight against falling back to an empty or last-good snapshot.
      if (report.outcome !== 'loaded' && report.outcome !== 'unchanged') {
        throw new Error(`Config hydration did not succeed: ${report.outcome}`);
      }
      const rejectedRouting = report.skipped.filter(
        ({ key }) =>
          key.startsWith(`task.${QUESTION_ADMISSION_TASK_KIND}.`) ||
          key === 'lane.global.provider' ||
          key === 'lane.global.model',
      );
      if (rejectedRouting.length > 0) {
        throw new Error(
          `Config hydration rejected routing keys: ${rejectedRouting.map(({ key, reason }) => `${key} (${reason})`).join(', ')}`,
        );
      }
      closeHydratedDb = () => db.$client.end();
      configDbLayer = 'hydrated';
      configHydration = { outcome: report.outcome, epoch: report.epoch };
    } catch (error) {
      await db.$client.end().catch(() => {});
      throw new Error(
        `DATABASE_URL is set but the DB config layer failed to hydrate — refusing to resolve routing env-only before any provider request or reopen: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const solverA = resolveTaskProvider(QUESTION_ADMISSION_TASK_KIND);
  const solver2Provider = process.env.QUESTION_ADMISSION_SOLVER2_PROVIDER;
  const solver2Model = process.env.QUESTION_ADMISSION_SOLVER2_MODEL;
  const solverB =
    solver2Provider || solver2Model
      ? resolveTaskProvider(QUESTION_ADMISSION_TASK_KIND, {
          ...(solver2Provider ? { provider: solver2Provider as Provider } : {}),
          ...(solver2Model ? { model: solver2Model } : {}),
        })
      : solverA;

  // A and B keep their own identities even when they resolve to the same lane —
  // the preflight owes each solver a real request, not a deduped share.
  const routes = new Map<'A' | 'B', ProbeRoute>();
  for (const [solver, resolved] of [
    ['A', solverA],
    ['B', solverB],
  ] as const) {
    try {
      assertModelProfileCapabilityFit(
        questionAdmissionSolveTaskSpec.definition,
        resolved.provider,
        resolved.model,
      );
      const native = nativePiModel(resolved.provider, resolved.model);
      if (native?.api !== 'openai-completions') {
        throw new Error('Require an OpenAI-completions model');
      }
      routes.set(solver, {
        solver,
        provider: resolved.provider,
        model: resolved.model,
        api: native.api,
        endpoint: native.baseUrl,
        apiKey: resolved.apiKey,
        ...(resolved.nativeReasoningParams
          ? { nativeReasoning: resolved.nativeReasoningParams }
          : {}),
        ...(resolved.selectionRule ? { selectionRule: resolved.selectionRule } : {}),
        ...(resolved.provider === 'opencode-go' ? { sessionHeader: true } : {}),
      });
    } catch (error) {
      throw new Error(
        `Solver ${solver} routing refused before re-pend: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const routeA = routes.get('A');
  const routeB = routes.get('B');
  if (!routeA || !routeB) throw new Error('solver route resolution incomplete');
  return {
    routeA,
    routeB,
    solver2Provider,
    solver2Model,
    policy: process.env.QUESTION_ADMISSION_POLICY_ID,
    config_db_layer: configDbLayer,
    ...(configHydration ? { config_hydration: configHydration } : {}),
  };
}

/**
 * Synthetic probe inputs — one per prompt mode the admission lane runs.
 * The user message is the same JSON.stringify(payload) the runner sends; the
 * system prompt is the task's own prompt + the shared structured-submit
 * suffix, so the probe exercises the REAL request contract rather than a
 * bespoke one.
 */
const SOLVE_PROBE_INPUT = {
  mode: 'solve' as const,
  parts: [
    {
      part_id: 'p',
      prompt_md:
        'What is 1+1? scoring_unit_id=u. No other question is supplied. This is a synthetic preflight probe.',
    },
  ],
  units: [
    {
      scoring_unit_id: 'u',
      part_id: 'p',
      kind: 'blank' as const,
      printed_points: 1,
      blank: { format: 'text' as const, answer_kind: 'blank_numeric' as const },
    },
  ],
};
const CROSSCHECK_PROBE_INPUT = {
  mode: 'source_crosscheck' as const,
  parts: SOLVE_PROBE_INPUT.parts,
  units: SOLVE_PROBE_INPUT.units,
  source_answers: [
    { scoring_unit_id: 'u', reference_md: '参考答案：2', locator: 'synthetic printed key' },
  ],
  proposals: [{ scoring_unit_id: 'u', answer_summary_md: '数值：2（容差 ±0）' }],
};

interface ProbePlan {
  /** Which solver identity this probe exercises — A and B always each get a real
   *  request even when they resolve to the same lane. */
  solver: 'A' | 'B';
  mode: 'solve' | 'source_crosscheck';
  route: ProbeRoute;
}

/**
 * One bounded submit probe: the initial request plus — only when the shared
 * turn machine says 'needs_reminder' — exactly one authorized landing request
 * carrying the verbatim assistant turn back (the same contract the adapter
 * runs via getFollowUpMessages). 4xx, a malformed/truncated submit, or any
 * non-clean tool turn fails immediately; nothing retries.
 */
async function runProbe(
  plan: ProbePlan,
  input: unknown,
  parameters: Record<string, unknown>,
  receiptProbes: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const { route } = plan;
  const submitPolicy = resolveStructuredSubmitPolicy(route.provider, route.model);
  const probe: Record<string, unknown> = {
    solver: plan.solver,
    mode: plan.mode,
    provider: route.provider,
    model: route.model,
    endpoint: route.endpoint,
    selection_rule: route.selectionRule,
    submit_tool_choice: submitPolicy.forced ? 'forced' : 'auto',
    forced_tool_choice_capability: submitPolicy.capability,
    ...(route.nativeReasoning ?? {}),
    requests: [] as Record<string, unknown>[],
    landing_turn_used: false,
  };
  // Attach before sending: the outer finally must retain failure evidence
  // and any earlier paid turn even when this probe never returns successfully.
  receiptProbes.push(probe);
  const messages: Record<string, unknown>[] = [
    {
      role: 'system',
      content:
        getTaskSystemPrompt(QUESTION_ADMISSION_TASK_KIND) +
        structuredSubmitSystemSuffix(submitPolicy.forced),
    },
    { role: 'user', content: JSON.stringify(input) },
  ];
  for (;;) {
    const requests = probe.requests as Record<string, unknown>[];
    if (requests.length >= 2) {
      throw new Error('preflight probe exceeded its authorized turn bound (initial + one landing)');
    }
    const reqRecord: Record<string, unknown> = {
      role: requests.length === 0 ? 'initial' : 'landing',
      started_at: new Date().toISOString(),
    };
    // A transport failure still represents a sent request with unknown cost.
    requests.push(reqRecord);
    const response = await fetch(`${route.endpoint}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
      headers: {
        Authorization: `Bearer ${route.apiKey}`,
        'Content-Type': 'application/json',
        ...(route.sessionHeader
          ? { 'x-opencode-session': `question-admission-preflight-${randomUUID()}` }
          : {}),
      },
      body: JSON.stringify({
        model: route.model,
        max_tokens: 4096,
        stream: false,
        ...(route.nativeReasoning ?? {}),
        messages,
        tools: [
          {
            type: 'function',
            function: {
              name: submit,
              description: 'Submit the structured output object',
              parameters,
            },
          },
        ],
        ...structuredSubmitWireFields(submitPolicy),
      }),
    });
    reqRecord.http_status = response.status;
    if (response.status !== 200) {
      // YUK-1559 (C6) — a non-2xx leaves the sanitized, bounded provider
      // error body + status + request id on the receipt, so a refused
      // preflight is diagnosable without a second request.
      reqRecord.provider_error = await readProviderErrorEvidence(response, {
        secrets: [route.apiKey],
      });
      probe.http_status = response.status;
      throw new Error(
        `Preflight HTTP ${response.status} for ${route.provider}/${route.model} mode=${plan.mode}; stop before reopening`,
      );
    }
    const body = (await response.json()) as {
      id?: string;
      usage?: unknown;
      choices?: {
        finish_reason?: string;
        message?: {
          content?: unknown;
          tool_calls?: {
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
    };
    reqRecord.provider_request_id = body.id;
    reqRecord.usage = body.usage ?? null;
    const choice = body.choices?.[0];
    if (body.choices?.length !== 1 || !choice?.message) {
      throw new Error('Preflight requires exactly one choice');
    }
    const calls = choice.message.tool_calls ?? [];
    const verdict = classifySubmitTurn(
      {
        stopReason: choice.finish_reason,
        toolCallNames: calls.map((call) => call.function?.name ?? ''),
      },
      { forced: submitPolicy.forced },
    );
    if (verdict === 'terminal_failure') {
      probe.http_status = response.status;
      throw new Error(
        `Preflight turn terminal_failure: mode=${plan.mode} finish_reason=${choice.finish_reason} tool_calls=${calls.map((c) => c.function?.name).join(',') || 'none'}`,
      );
    }
    if (verdict === 'needs_reminder') {
      // The assistant turn is carried back verbatim, then the shared reminder —
      // exactly the adapter's one-landing contract.
      probe.landing_turn_used = true;
      messages.push(choice.message as Record<string, unknown>, {
        role: 'user',
        content: STRUCTURED_SUBMIT_REMINDER,
      });
      continue;
    }
    probe.http_status = response.status;
    const rawArguments = calls[0].function?.arguments ?? '';
    // Synthetic 1+1 probe only, no question text or credentials: keep the raw
    // arguments so a failed probe can be diagnosed without a second request.
    probe.raw_arguments = rawArguments.slice(0, 8000);
    const args: unknown = JSON.parse(rawArguments);
    probe.arguments_was_string = typeof args === 'string';
    // Shared parameter-contract repair — the SAME seam the pi adapter applies
    // at prepareArguments for every mounted tool (one strict JSON.parse per
    // string field whose sub-schema expects array/object). A rejected repair
    // becomes the probe's single correction turn: the isError feedback is
    // replayed as the tool-result message and the run's extra-turn bound
    // (initial + one landing, enforced by requests.length) is shared with the
    // missing-submit reminder — never one each.
    let effective: unknown;
    try {
      const repaired = repairToolArguments(parameters, args);
      if (repaired.coercions.length > 0) probe.coerced_fields = repaired.coercions;
      effective = repaired.args;
    } catch (error) {
      if (!isToolParamContractError(error)) throw error;
      probe.param_contract_rejection = sanitizeProviderErrorText(
        error instanceof Error ? error.message : String(error),
        { secrets: [route.apiKey] },
      );
      const toolCallId = calls[0]?.id;
      if ((probe.landing_turn_used as boolean) === true || typeof toolCallId !== 'string') {
        throw error;
      }
      probe.landing_turn_used = true;
      messages.push(choice.message as Record<string, unknown>, {
        role: 'tool',
        tool_call_id: toolCallId,
        name: submit,
        content: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (plan.mode === 'solve') {
      // Same parse entry as the solve path (string tolerated at this level), with
      // the repair budget at zero so the probe proves strict schema validity.
      const output = parseQuestionAdmissionSolveModelOutput(effective, [], { remaining: 0 });
      const answer = output.units[0]?.answer;
      if (
        output.units.length !== 1 ||
        output.units[0].scoring_unit_id !== 'u' ||
        output.units[0].status !== 'solved' ||
        answer?.kind !== 'blank_numeric' ||
        answer.expected !== 2
      )
        throw new Error('Invalid preflight synthetic answer');
      probe.output = output;
    } else {
      const output = QuestionAdmissionSourceCrosscheckOutput.parse(effective);
      const entry = output.per_unit[0];
      if (output.per_unit.length !== 1 || entry.scoring_unit_id !== 'u')
        throw new Error('Invalid preflight synthetic crosscheck output');
      probe.output = output;
    }
    return probe;
  }
}

async function preflight(path: string) {
  const {
    routeA,
    routeB,
    solver2Provider,
    solver2Model,
    policy,
    config_db_layer,
    config_hydration,
  } = await routing();
  // Refuse an existing receipt BEFORE any request. Failed attempts also
  // leave a receipt; this command never retries, overwrites, or reopens a claim.
  const file = await open(path, 'wx');
  const receipt: Record<string, unknown> = {
    passed: false,
    created_at: new Date().toISOString(),
    routing_hash: hash({
      routes: [routeA, routeB].map(({ apiKey: _apiKey, ...publicRoute }) => publicRoute),
      solver2Provider,
      solver2Model,
      policy,
      config_db_layer,
    }),
    schema_hash: hash(schema),
    outside_paid_effect: true,
    config_db_layer,
    config_hydration,
    probes: [] as Record<string, unknown>[],
  };
  const probes = receipt.probes as Record<string, unknown>[];
  // One real request per solver identity (A and B keep theirs even on the same
  // lane) plus one 'source_crosscheck' probe on the primary route — crosscheck
  // never takes a per-call override in runSourceCrosscheck, so route A IS its
  // lane. Each probe is the shared bounded submit machine: initial request +
  // at most one authorized landing turn.
  const plans: ProbePlan[] = [
    { solver: 'A', mode: 'solve', route: routeA },
    { solver: 'B', mode: 'solve', route: routeB },
    { solver: 'A', mode: 'source_crosscheck', route: routeA },
  ];
  try {
    for (const plan of plans) {
      const input =
        plan.mode === 'solve'
          ? QuestionAdmissionSolveInput.parse(SOLVE_PROBE_INPUT)
          : QuestionAdmissionSourceCrosscheckInput.parse(CROSSCHECK_PROBE_INPUT);
      await runProbe(plan, input, schema, probes);
    }
    receipt.passed = true;
    console.log('PASS: HTTP 200; exactly one submit call; strict schema; no paid_effect created');
  } catch (error) {
    // The message is written to the receipt AND rethrown to the process-level
    // console log — run it through the same sanitize boundary against every
    // probe credential so a provider/SDK error text that echoes a request
    // value cannot reach either sink. Stack/cause are not receipt-relevant.
    const secrets = [routeA, routeB].map((route) => route.apiKey);
    const sanitized = sanitizeProviderErrorText(
      error instanceof Error ? error.message : String(error),
      { secrets },
    );
    receipt.error = sanitized;
    throw new Error(sanitized);
  } finally {
    await file.writeFile(JSON.stringify(receipt, null, 2));
    await file.close();
  }
}

// ─── generic void + successor reauthorization (YUK-1567) ────────────────────

function requireTestDb(): void {
  if (
    !process.env.DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.YUK1547_TEST_DATABASE_URL
  ) {
    throw new Error('Explicitly set YUK1547_TEST_DATABASE_URL to the approved TEST DATABASE_URL');
  }
}

interface GroupEval {
  failures: string[];
  revisionId: string | null;
  availability: 'general_pool' | 'container_only' | null;
  withheldReason: string | null;
  baseGeneration: number;
  republishGenerations: number[];
  ghostGenerations: number[];
  finalGeneration: number;
  contractLayers: Record<string, unknown> | null;
  successorInput: FrozenAdmissionInput | null;
  successorInputDigest: string | null;
  jobId: string | null;
  ghostJobIds: string[];
  manifestItem: Record<string, unknown> | null;
}

/**
 * Freeze the successor's FrozenAdmissionInput exactly the way the job derives
 * it at claim time — same seal layers, profile, resolved policy and solver2
 * env. The digest computed here is what the authorization binds and what the
 * --execute drift check re-verifies before any write.
 */
async function buildSuccessorInput(
  tx: Tx,
  opts: {
    groupId: string;
    baseDigest: string;
    revisionId: string;
    generation: number;
    unit: string;
  },
): Promise<{
  input: FrozenAdmissionInput;
  identity: ReturnType<typeof computePaidEffectIdentity>;
  contractLayers: Record<string, unknown>;
}> {
  const { knowledge, question, question_revision } = await import('@/db/schema');
  const { publishedContractSeal, publishedSealAccepts } = await import(
    '@/kernel/records/assessment-normalization'
  );
  const [revision] = await tx
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, opts.revisionId));
  if (!revision) throw new Error('revision missing while freezing the successor input');
  const seal = publishedContractSeal({
    structure: revision.structure,
    response_spec: revision.response_spec,
    scoring_basis: revision.scoring_basis,
    execution_plan: revision.execution_plan,
    ...(revision.presentation != null ? { presentation: revision.presentation } : {}),
  });
  if (!publishedSealAccepts(seal, revision.integrity_digest)) {
    throw new Error('revision layers no longer seal to the stored digest');
  }
  const [row] = await tx
    .select({ knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(eq(question.id, opts.groupId))
    .limit(1);
  const first = row?.knowledge_ids?.[0];
  const [node] = first
    ? await tx
        .select({ domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, first))
        .limit(1)
    : [undefined];
  const solver2Provider = process.env.QUESTION_ADMISSION_SOLVER2_PROVIDER;
  const solver2Model = process.env.QUESTION_ADMISSION_SOLVER2_MODEL;
  const input = FrozenAdmissionInput.parse(
    JSON.parse(
      JSON.stringify({
        version: 1,
        group_id: opts.groupId,
        revision_id: opts.revisionId,
        revision_digest: opts.baseDigest,
        admission_generation: opts.generation,
        contract: {
          ...seal.parsed,
          integrity_digest: opts.baseDigest,
          group_id: opts.groupId,
          conversion_issues: [],
        },
        subject_profile: resolveSubjectProfile(node?.domain ?? null),
        policy_id: resolveQuestionAdmissionPolicyId(),
        solver2:
          solver2Provider || solver2Model
            ? { provider: solver2Provider, model: solver2Model }
            : null,
      }),
    ),
  );
  const identity = computePaidEffectIdentity({
    family: ADMISSION_FAMILY,
    entityId: opts.groupId,
    entityRevision: opts.baseDigest,
    unit: opts.unit,
    input,
  });
  return { input, identity, contractLayers: seal.parsed as Record<string, unknown> };
}

type ManifestGroup = ReopenManifest['groups'][number];

/**
 * THE eligibility predicate shared by --plan (read-only) and --execute
 * (re-verified under the same locks before any write). A group is eligible
 * only when the manifest names EVERY 'unknown' paid row on the entity with
 * matching fences, no active/in-flight send exists for it anywhere (sending
 * row, pending intent, receipt owed application, live job, unsettled
 * enqueue-subscription delivery, undiscovered publish event), no applied
 * verdict or terminal verification would resolve the claim without a send,
 * and the current revision still seals to the manifest's base digest.
 */
async function evaluateGroup(tx: Tx, entry: ManifestGroup): Promise<GroupEval> {
  const failures: string[] = [];
  const { paid_effect, question_admission_verification, question_revision } = await import(
    '@/db/schema'
  );
  const resolvedPolicy = resolveQuestionAdmissionPolicyId();
  const evalResult: GroupEval = {
    failures,
    revisionId: null,
    availability: null,
    withheldReason: null,
    baseGeneration: 0,
    republishGenerations: [],
    ghostGenerations: [],
    finalGeneration: 0,
    contractLayers: null,
    successorInput: null,
    successorInputDigest: null,
    jobId: null,
    ghostJobIds: [],
    manifestItem: null,
  };
  const { root, lifecycle } = await lockAdmissionGroup(tx, entry.group_id);
  if (!root) {
    failures.push('group root missing');
    return evalResult;
  }
  if (root.parent_question_id !== null) failures.push('not a group root');
  if (!lifecycle) {
    failures.push('lifecycle missing');
    return evalResult;
  }
  if (lifecycle.withdrawn) failures.push('withdrawn');
  if (lifecycle.suspended) failures.push('suspended');
  if (lifecycle.scoring_admission_state !== 'withheld') {
    failures.push(`lifecycle '${lifecycle.scoring_admission_state}' is not withheld`);
  }
  if (!lifecycle.current_revision_id) failures.push('no current revision');
  const [revision] = lifecycle.current_revision_id
    ? await tx
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, lifecycle.current_revision_id))
    : [];
  if (!revision || revision.group_id !== entry.group_id) {
    failures.push('current revision missing or belongs to another group');
  } else if (revision.integrity_digest !== entry.base_digest) {
    failures.push('current revision digest != manifest base_digest');
  } else {
    evalResult.revisionId = revision.revision_id;
  }
  // Every paid row on the entity is accounted for: named 'unknown' rows are
  // voided, historical 'voided' rows stay, applied verdicts on OTHER bases are
  // out of scope — everything else blocks the reauthorization.
  const effects = await tx
    .select()
    .from(paid_effect)
    .where(and(eq(paid_effect.family, ADMISSION_FAMILY), eq(paid_effect.entity_id, entry.group_id)))
    .for('update');
  const voidKeys = new Set(entry.void.map((v) => `${v.unit}|${v.input_digest}`));
  if (voidKeys.size !== entry.void.length) {
    failures.push('manifest void list contains duplicate targets');
  }
  const seen = new Set<string>();
  for (const effect of effects) {
    const key = `${effect.unit}|${effect.input_digest}`;
    const target = entry.void.find(
      (v) => v.unit === effect.unit && v.input_digest === effect.input_digest,
    );
    if (target) {
      seen.add(key);
      if (effect.state !== 'unknown') {
        failures.push(`void target ${key} is '${effect.state}', not 'unknown'`);
      } else if (effect.fence !== target.expected_fence) {
        failures.push(
          `void target ${key} fence ${effect.fence} != manifest expected_fence ${target.expected_fence}`,
        );
      }
      continue;
    }
    if (effect.state === 'voided') continue;
    if (effect.state === 'applied' && effect.entity_revision !== entry.base_digest) continue;
    if (effect.state === 'applied') {
      failures.push(`terminal applied verdict on base: ${key}`);
    } else {
      failures.push(`uncovered '${effect.state}' paid row on entity: ${key}`);
    }
  }
  for (const v of entry.void) {
    if (!seen.has(`${v.unit}|${v.input_digest}`)) {
      failures.push(`manifest void target missing: ${v.unit}|${v.input_digest}`);
    }
  }
  // No in-flight work may exist for the group: live jobs, unsettled
  // enqueue-subscription deliveries and undiscovered eligible publish events
  // all mean a send could still be racing the void.
  const liveJobs = await tx.execute<{ id: string }>(sql`
    select id from pgboss.job
    where name = ${ADMISSION_FAMILY} and data->>'question_id' = ${entry.group_id}
      and state in ('created','retry','active')`);
  if (liveJobs.length > 0) {
    failures.push(`non-terminal admission job(s): ${liveJobs.map((j) => j.id).join(',')}`);
  }
  const deliveries = await tx.execute<{ source_event_id: string; status: string }>(sql`
    select d.source_event_id, d.status::text as status
    from event_subscription_delivery d
    join event e on e.id = d.source_event_id and e.dispatch_seq = d.source_dispatch_seq
    where d.subscriber_id = ${ENQUEUE_SUBSCRIBER_ID}
      and d.status not in ('bootstrap_skipped','succeeded','skipped','dead_letter')
      and e.payload->>'group_id' = ${entry.group_id}`);
  if (deliveries.length > 0) {
    failures.push(
      `unsettled enqueue deliveries: ${deliveries.map((d) => `${d.source_event_id}:${d.status}`).join(',')}`,
    );
  }
  const undiscovered = await tx.execute<{ id: string }>(sql`
    select e.id from event e
    where e.action = ${PUBLISH_ACTION} and e.outcome = 'success'
      and e.actor_ref <> 'practice:question_admission'
      and e.payload->>'admission' = 'withheld'
      and e.payload->>'group_id' = ${entry.group_id}
      and not exists (
        select 1 from event_subscription_delivery d
        where d.subscriber_id = ${ENQUEUE_SUBSCRIBER_ID} and d.source_event_id = e.id)`);
  if (undiscovered.length > 0) {
    failures.push(
      `undiscovered eligible publish events: ${undiscovered.map((e2) => e2.id).join(',')}`,
    );
  }
  const [terminal] = await tx
    .select({ id: question_admission_verification.id })
    .from(question_admission_verification)
    .innerJoin(
      question_revision,
      eq(question_admission_verification.revision_id, question_revision.revision_id),
    )
    .where(
      and(
        eq(question_revision.group_id, entry.group_id),
        inArray(question_admission_verification.policy_id, [
          ...QUESTION_ADMISSION_POLICY_IDS,
          resolvedPolicy,
        ]),
        sql`${question_admission_verification.evidence}->>'pack' = 'question_admission'`,
        sql`${question_admission_verification.evidence}->>'base_contract_digest' = ${entry.base_digest}`,
        inArray(question_admission_verification.outcome, ['passed', 'failed', 'suspended']),
      ),
    )
    .limit(1);
  if (terminal) {
    failures.push('terminal admission verification on base — the claim would resolve historical');
  }
  if (failures.length === 0 && revision && lifecycle.current_revision_id) {
    const base = lifecycle.scoring_admission_generation;
    evalResult.baseGeneration = base;
    evalResult.withheldReason = lifecycle.scoring_admission_withheld_reason;
    evalResult.availability = lifecycle.availability;
    // Re-pend bumps generation once per admission update: owner_hold first
    // (skipped when already owner_hold), then unverified_rules — mirroring the
    // retired reopen exactly. Each emitted event is subscriber-visible.
    const dual = lifecycle.scoring_admission_withheld_reason !== 'owner_hold';
    evalResult.republishGenerations = dual ? [base + 1, base + 2] : [base + 1];
    evalResult.finalGeneration = base + evalResult.republishGenerations.length;
    evalResult.ghostGenerations = evalResult.republishGenerations.slice(0, -1);
    try {
      const successor = await buildSuccessorInput(tx, {
        groupId: entry.group_id,
        baseDigest: entry.base_digest,
        revisionId: revision.revision_id,
        generation: evalResult.finalGeneration,
        unit: entry.successor_unit,
      });
      evalResult.contractLayers = successor.contractLayers;
      evalResult.successorInput = successor.input;
      evalResult.successorInputDigest = successor.identity.inputDigest;
    } catch (error) {
      failures.push(
        `successor input freeze failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return evalResult;
    }
    evalResult.jobId = admissionJobId(
      entry.group_id,
      revision.revision_id,
      entry.base_digest,
      evalResult.finalGeneration,
    );
    evalResult.ghostJobIds = evalResult.ghostGenerations.map((generation) =>
      admissionJobId(entry.group_id, revision.revision_id, entry.base_digest, generation),
    );
    evalResult.manifestItem = {
      id: entry.group_id,
      version: root.version,
      suspended: lifecycle.suspended,
      created_at: root.created_at.toISOString(),
      generation: evalResult.finalGeneration,
      revision_id: revision.revision_id,
      integrity_digest: entry.base_digest,
      question_updated_at: root.updated_at.toISOString(),
      lifecycle_updated_at: lifecycle.updated_at.toISOString(),
    };
  }
  return evalResult;
}

const planArtifactSchema = z.object({
  version: z.literal(1),
  authorization: z.object({
    authorization_id: z.string().min(1),
    operator: z.string().min(1),
    basis: z.string().min(1),
    reason: z.string().min(1),
  }),
  eligible: z.boolean(),
  groups: z
    .array(
      z.object({
        group_id: z.string().min(1),
        base_digest: digest,
        successor_unit: z.string().min(1),
        eligible: z.boolean(),
        void: z
          .array(
            z.object({
              unit: z.string().min(1),
              input_digest: digest,
              expected_fence: z.number().int().nonnegative(),
            }),
          )
          .nonempty(),
        republish_generations: z.array(z.number().int().nonnegative()).nonempty(),
        final_generation: z.number().int().nonnegative(),
        ghost_generations: z.array(z.number().int().nonnegative()),
        revision_id: z.string().min(1),
        successor: z.object({
          unit: z.string().min(1),
          entity_revision: digest,
          input_digest: digest,
          job_id: z.string().min(1),
        }),
        ghost_job_ids: z.array(z.string()),
      }),
    )
    .nonempty(),
});
type PlanArtifact = z.infer<typeof planArtifactSchema>;
type PlanGroup = PlanArtifact['groups'][number];

/** --plan: dry, read-only eligibility evaluation that freezes the manifest. */
async function plan(manifestPath: string, outPath: string) {
  requireTestDb();
  const manifest = reopenManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const { db } = await import('@/db/client');
  try {
    const groups = await db.transaction(async (tx) => {
      const evaluated: GroupEval[] = [];
      for (const entry of manifest.groups) evaluated.push(await evaluateGroup(tx, entry));
      return evaluated;
    });
    const eligible = groups.every((g) => g.failures.length === 0);
    const artifact = {
      version: 1,
      planned_at: new Date().toISOString(),
      manifest_sha256: hash(manifest),
      authorization: {
        authorization_id: manifest.authorization_id,
        operator: manifest.operator,
        basis: manifest.basis,
        reason: manifest.reason,
      },
      eligible,
      groups: groups.map((g, i) => {
        const entry = manifest.groups[i];
        return {
          group_id: entry.group_id,
          base_digest: entry.base_digest,
          successor_unit: entry.successor_unit,
          eligible: g.failures.length === 0,
          failures: g.failures,
          void: entry.void,
          republish_generations: g.republishGenerations,
          final_generation: g.finalGeneration,
          ghost_generations: g.ghostGenerations,
          revision_id: g.revisionId ?? '',
          successor:
            g.successorInputDigest != null && g.jobId != null
              ? {
                  unit: entry.successor_unit,
                  entity_revision: entry.base_digest,
                  input_digest: g.successorInputDigest,
                  job_id: g.jobId,
                }
              : null,
          ghost_job_ids: g.ghostJobIds,
          manifest_item: g.manifestItem,
        };
      }),
    };
    // A frozen plan is write-once evidence — never overwrite an earlier plan.
    const file = await open(outPath, 'wx');
    try {
      await file.writeFile(JSON.stringify(artifact, null, 2));
    } finally {
      await file.close();
    }
    console.log(
      eligible ? `plan OK — wrote ${outPath}` : `plan has ineligible groups — wrote ${outPath}`,
    );
    if (!eligible) process.exitCode = 1;
  } finally {
    await db.$client.end();
  }
}

interface AuthorizedGroupEntry {
  group_id: string;
  base_digest: string;
  revision_id: string;
  admission_generation: number;
  job_id: string;
  successor: { unit: string; input_digest: string };
  voided: { unit: string; input_digest: string }[];
  sent_at: string;
  owned_events: { event_id: string; revision_id: string; admission_generation: number }[];
  extra_owned_job_generations: number[];
  resumed?: boolean;
}

async function executeGroup(
  tx: Tx,
  g: PlanGroup,
  auth: PlanArtifact['authorization'],
  boss: Awaited<
    ReturnType<typeof import('@/capabilities/practice/server/queue-runtime').getPracticeBoss>
  >,
): Promise<AuthorizedGroupEntry> {
  const { lockPaidEffectControlFamily, readPaidEffectControl } = await import(
    '@/db/paid-effect-control'
  );
  const { practiceBossTransaction } = await import('@/capabilities/practice/server/queue-runtime');
  const { publishQuestionGroup } = await import('@/kernel/records/assessment-publication');
  const { getR2 } = await import('@/server/r2');
  await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
  // Re-verify EVERYTHING under the locks the write will take — the frozen
  // plan's fences/identity digests must still hold or the run aborts.
  const fresh = await evaluateGroup(tx, {
    group_id: g.group_id,
    base_digest: g.base_digest,
    successor_unit: g.successor_unit,
    void: g.void,
  });
  if (fresh.failures.length > 0) {
    throw new Error(`${g.group_id}: re-verification failed: ${fresh.failures.join('; ')}`);
  }
  if (
    fresh.finalGeneration !== g.final_generation ||
    fresh.successorInputDigest !== g.successor.input_digest ||
    fresh.jobId !== g.successor.job_id ||
    fresh.revisionId !== g.revision_id
  ) {
    throw new Error(`${g.group_id}: plan drifted since --plan — re-run --plan`);
  }
  const control = await readPaidEffectControl(tx, ADMISSION_FAMILY);
  if (control.backend !== 'pg-boss') throw new Error('Admission producer fenced');
  const events: AuthorizedGroupEntry['owned_events'] = [];
  let generation = fresh.baseGeneration;
  for (const reason of ['owner_hold', 'unverified_rules'] as const) {
    if (reason === 'owner_hold' && fresh.withheldReason === 'owner_hold') continue;
    const published = await publishQuestionGroup(tx, {
      group_id: g.group_id,
      contract: {
        ...(fresh.contractLayers ?? {}),
        integrity_digest: g.base_digest,
      } as PublishQuestionGroupInput['contract'],
      expectedCurrentRevision: fresh.revisionId,
      expectedAdmissionGeneration: generation,
      availability: fresh.availability ?? 'general_pool',
      admission: { state: 'withheld', reason },
      actorRef: ACTOR_REF,
      now: new Date(),
      readAssetBytes: (key) => getR2().get(key),
    });
    if (
      published.status !== 'admission_updated' ||
      published.current_revision_id !== fresh.revisionId
    ) {
      throw new Error('Reopen must be a dimension-only update');
    }
    generation = published.admission_generation;
    events.push({
      event_id: published.event_id,
      revision_id: published.current_revision_id ?? (fresh.revisionId as string),
      admission_generation: generation,
    });
  }
  if (generation !== g.final_generation) {
    throw new Error(`${g.group_id}: republish generation drifted from the frozen plan`);
  }
  if (!fresh.successorInput) throw new Error(`${g.group_id}: successor input missing`);
  const queued = await boss.send(
    ADMISSION_FAMILY,
    {
      admission_version: 3,
      question_id: g.group_id,
      revision_id: fresh.revisionId ?? undefined,
      expected_revision_digest: g.base_digest,
      expected_admission_generation: generation,
      dispatch_generation: control.generation,
    } satisfies AdmissionJobData,
    { id: g.successor.job_id, db: practiceBossTransaction(tx) },
  );
  if (queued === null) {
    throw new Error(`bound job ${g.successor.job_id} already exists; inspect instead of replaying`);
  }
  // Void + authorize + admit the successor intent — inside this same
  // transaction so the reservation and the bound job commit together.
  for (const v of g.void) {
    await voidPaidEffectWithSuccessor(
      tx,
      {
        family: ADMISSION_FAMILY,
        entityId: g.group_id,
        entityRevision: g.base_digest,
        unit: v.unit,
        inputDigest: v.input_digest,
      },
      {
        expectedFence: v.expected_fence,
        authorization: {
          authorizationId: auth.authorization_id,
          reason: auth.reason,
          operator: auth.operator,
          basis: auth.basis,
          successorInput: {
            family: ADMISSION_FAMILY,
            entityId: g.group_id,
            entityRevision: g.base_digest,
            unit: g.successor_unit,
            input: fresh.successorInput,
          },
          successorDelivery: { backend: 'pg-boss', deliveryId: g.successor.job_id },
        },
      },
    );
  }
  return {
    group_id: g.group_id,
    base_digest: g.base_digest,
    revision_id: fresh.revisionId ?? '',
    admission_generation: generation,
    job_id: g.successor.job_id,
    successor: { unit: g.successor_unit, input_digest: g.successor.input_digest },
    voided: g.void.map((v) => ({ unit: v.unit, input_digest: v.input_digest })),
    sent_at: new Date().toISOString(),
    owned_events: events,
    extra_owned_job_generations: fresh.ghostGenerations,
  };
}

/** How many manifest void rows are already voided under THIS authorization. */
async function countAlreadyVoided(db: Db, plan: PlanArtifact): Promise<number> {
  const { paid_effect } = await import('@/db/schema');
  let count = 0;
  for (const g of plan.groups) {
    const rows = await db
      .select({
        unit: paid_effect.unit,
        input_digest: paid_effect.input_digest,
        state: paid_effect.state,
        void_json: paid_effect.void_json,
      })
      .from(paid_effect)
      .where(and(eq(paid_effect.family, ADMISSION_FAMILY), eq(paid_effect.entity_id, g.group_id)));
    for (const v of g.void) {
      const row = rows.find((r) => r.unit === v.unit && r.input_digest === v.input_digest);
      if (
        row?.state === 'voided' &&
        (row.void_json as { authorizationId?: string } | null)?.authorizationId ===
          plan.authorization.authorization_id
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * A committed run that crashed before writing the manifest: all rows are
 * voided under this authorization, so recover the manifest evidence from the
 * DB (republish events by group+revision+generation, sent_at from voided_at)
 * instead of re-mutating.
 */
async function recoverAuthorizedGroups(
  db: Db,
  plan: PlanArtifact,
): Promise<AuthorizedGroupEntry[]> {
  const { paid_effect } = await import('@/db/schema');
  const results: AuthorizedGroupEntry[] = [];
  for (const g of plan.groups) {
    const rows = await db
      .select({
        unit: paid_effect.unit,
        input_digest: paid_effect.input_digest,
        state: paid_effect.state,
        voided_at: paid_effect.voided_at,
        void_json: paid_effect.void_json,
      })
      .from(paid_effect)
      .where(and(eq(paid_effect.family, ADMISSION_FAMILY), eq(paid_effect.entity_id, g.group_id)));
    const voidedRows = g.void.map((v) =>
      rows.find((r) => r.unit === v.unit && r.input_digest === v.input_digest),
    );
    const sentAt = voidedRows.find((r) => r?.voided_at)?.voided_at?.toISOString();
    const events = (await db.execute(sql`
      select e.id as event_id, e.payload->>'revision_id' as revision_id,
             e.payload->>'admission_generation' as admission_generation
      from event e
      where e.action = ${PUBLISH_ACTION} and e.outcome = 'success'
        and e.payload->>'group_id' = ${g.group_id}
        and e.payload->>'revision_id' = ${g.revision_id}
        and e.payload->>'admission_generation' = any(${g.republish_generations.map(String)}::text[])
      order by e.dispatch_seq`)) as unknown as {
      event_id: string;
      revision_id: string;
      admission_generation: string;
    }[];
    results.push({
      group_id: g.group_id,
      base_digest: g.base_digest,
      revision_id: g.revision_id,
      admission_generation: g.final_generation,
      job_id: g.successor.job_id,
      successor: { unit: g.successor_unit, input_digest: g.successor.input_digest },
      voided: g.void.map((v) => ({ unit: v.unit, input_digest: v.input_digest })),
      sent_at: sentAt ?? new Date().toISOString(),
      owned_events: events.map((e) => ({
        event_id: e.event_id,
        revision_id: e.revision_id,
        admission_generation: Number(e.admission_generation),
      })),
      extra_owned_job_generations: g.ghost_generations,
      resumed: true,
    });
  }
  return results;
}

/** --execute: replay the frozen plan; ONE transaction covers every group. */
async function execute(planPath: string, receiptPath: string, manifestOutPath: string) {
  const { routeA, routeB, solver2Provider, solver2Model, policy, config_db_layer } =
    await routing();
  const receipt = z
    .object({
      passed: z.literal(true),
      created_at: z.string().datetime(),
      routing_hash: z.string(),
      schema_hash: z.string(),
      probes: z.array(z.object({ http_status: z.literal(200) })).min(1),
    })
    .parse(JSON.parse(await readFile(receiptPath, 'utf8')));
  const age = Date.now() - Date.parse(receipt.created_at);
  if (
    age < 0 ||
    age > 60 * 60_000 ||
    receipt.routing_hash !==
      hash({
        routes: [routeA, routeB].map(({ apiKey: _apiKey, ...publicRoute }) => publicRoute),
        solver2Provider,
        solver2Model,
        policy,
        config_db_layer,
      }) ||
    receipt.schema_hash !== hash(schema)
  ) {
    throw new Error('Require the successful preflight from this schema/routing within one hour');
  }
  requireTestDb();
  const plan = planArtifactSchema.parse(JSON.parse(await readFile(planPath, 'utf8')));
  if (!plan.eligible || plan.groups.some((g) => !g.eligible || g.successor == null)) {
    throw new Error('plan has ineligible groups — re-run --plan');
  }
  const { db } = await import('@/db/client');
  const { getPracticeBoss } = await import('@/capabilities/practice/server/queue-runtime');
  const boss = await getPracticeBoss();
  try {
    // The run commits atomically: either every named row is already voided
    // under this authorization (crash before the manifest write — recover,
    // never re-mutate) or none is (execute). A partial count is inconsistent
    // state that a re-run must NOT paper over.
    const totalVoid = plan.groups.reduce((sum, g) => sum + g.void.length, 0);
    const already = await countAlreadyVoided(db, plan);
    if (already > 0 && already < totalVoid) {
      throw new Error(
        `inconsistent partial void state (${already}/${totalVoid} rows voided under ${plan.authorization.authorization_id}) — inspect before retrying`,
      );
    }
    const groups =
      already === totalVoid
        ? await recoverAuthorizedGroups(db, plan)
        : await db.transaction(async (tx) => {
            const out: AuthorizedGroupEntry[] = [];
            for (const g of plan.groups)
              out.push(await executeGroup(tx, g, plan.authorization, boss));
            return out;
          });
    await writeFile(
      manifestOutPath,
      JSON.stringify(
        {
          version: 1,
          authorization_id: plan.authorization.authorization_id,
          executed_at: new Date().toISOString(),
          groups,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        authorized: groups.map((g) => `${g.group_id}:${g.job_id}${g.resumed ? ' (resumed)' : ''}`),
        old_paid_rows: 'voided only via the protocol transition',
      }),
    );
  } finally {
    await boss.stop();
    await db.$client.end();
  }
}

const [mode, positional, ...flagArgs] = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < flagArgs.length; i += 1) {
  const arg = flagArgs[i];
  if (arg.startsWith('--')) {
    const next = flagArgs[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[arg.slice(2)] = next;
      i += 1;
    } else {
      flags[arg.slice(2)] = 'true';
    }
  }
}
const run =
  mode === '--help'
    ? Promise.resolve(
        console.log(
          'TEST only: --preflight <new-receipt.json> | --plan <manifest.json> --out <plan.json> | --execute <plan.json> --preflight-receipt <receipt.json> --manifest-out <authorized.json>. ' +
            'Preflight sends one probe per admission mode (solve per distinct resolved solver lane + one source_crosscheck on the primary lane). ' +
            '--plan is read-only and freezes the void+reauthorization manifest; ' +
            '--execute voids the named unknown rows under the shared successor-authorization protocol and enqueues the bound jobs in one transaction. ' +
            'Never retries; no Docker.',
        ),
      )
    : mode === '--preflight' && positional
      ? preflight(positional)
      : mode === '--plan' && positional && flags.out
        ? plan(positional, flags.out)
        : mode === '--execute' && positional && flags['preflight-receipt'] && flags['manifest-out']
          ? execute(positional, flags['preflight-receipt'], flags['manifest-out'])
          : Promise.reject(new Error('Use --help; explicit mode and paths are required'));
run
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeHydratedDb?.().catch(() => {});
  });
