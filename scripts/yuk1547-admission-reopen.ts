// Lead-only TEST operation. No automatic caller; no tests or Docker operations.
// Preflight sends ONE provider request outside paid_effect. Reopen atomically
// re-pends and enqueues exactly five explicitly named @2 identities —
// admission@2 rows in state 'unknown', or the single @2 applied row whose
// verdict withheld on the blank_text-vs-blank_numeric kind-mismatch conflict.
// Old paid rows are never updated; the marked @3 jobs carry the exact old row
// identity (unit + input digest) as reopen_paid_effect_identity.
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { and, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Provider } from '@/ai/task-spec';
import {
  ADMISSION_FAMILY,
  admissionJobId,
  lockAdmissionGroup,
} from '@/capabilities/practice/server/admission/enqueue';
import { isKindMismatchSolveConflict } from '@/capabilities/practice/server/admission/receipt';
import { QUESTION_ADMISSION_TASK_KIND } from '@/capabilities/practice/server/admission/solve';
import {
  QuestionAdmissionSolveInput,
  QuestionAdmissionSourceCrosscheckInput,
  QuestionAdmissionSourceCrosscheckOutput,
  parseQuestionAdmissionSolveModelOutput,
  questionAdmissionSolveTaskSpec,
} from '@/capabilities/practice/tasks/question-admission-solve';
import { getTaskSystemPrompt } from '@/capabilities/task-registry';
import {
  LEGACY_QUESTION_ADMISSION_PAID_UNIT,
  PREVIOUS_QUESTION_ADMISSION_PAID_UNIT,
  QUESTION_ADMISSION_PAID_UNIT,
  QUESTION_ADMISSION_PAID_UNITS,
} from '@/core/question-admission-policy';
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

const submit = STRUCTURED_OUTPUT_SUBMIT_TOOL;
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const manifestSchema = z
  .array(
    z.object({
      group_id: z.string().min(1),
      base_digest: digest,
      input_digest: digest,
    }),
  )
  .length(5);
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

async function reopen(receiptPath: string, manifestPath: string) {
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
  if (
    !process.env.DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.YUK1547_TEST_DATABASE_URL
  ) {
    throw new Error('Explicitly set YUK1547_TEST_DATABASE_URL to the approved TEST DATABASE_URL');
  }
  const rows = manifestSchema
    .parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    .sort((a, b) => a.group_id.localeCompare(b.group_id));
  if (new Set(rows.map((row) => row.group_id)).size !== 5)
    throw new Error('Require five distinct approved groups');
  const { db } = await import('@/db/client');
  const { paid_effect, question_revision } = await import('@/db/schema');
  const { lockPaidEffectControlFamily, readPaidEffectControl } = await import(
    '@/db/paid-effect-control'
  );
  const { getPracticeBoss, practiceBossTransaction } = await import(
    '@/capabilities/practice/server/queue-runtime'
  );
  const { publishQuestionGroup } = await import('@/kernel/records/assessment-publication');
  const { publishedContractSeal, publishedSealAccepts } = await import(
    '@/kernel/records/assessment-normalization'
  );
  const { getR2 } = await import('@/server/r2');
  const boss = await getPracticeBoss();
  try {
    const jobs = await db.transaction(async (tx) => {
      await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
      const [oldReceipts] = await tx
        .select({ count: count() })
        .from(paid_effect)
        .where(
          and(
            eq(paid_effect.family, ADMISSION_FAMILY),
            inArray(paid_effect.unit, [
              LEGACY_QUESTION_ADMISSION_PAID_UNIT,
              PREVIOUS_QUESTION_ADMISSION_PAID_UNIT,
            ]),
            eq(paid_effect.state, 'receipt_ready'),
          ),
        );
      if (oldReceipts.count !== 0)
        throw new Error(
          'Stop: admission@1/@2 receipt_ready rows must be reconciled before cutover',
        );
      const control = await readPaidEffectControl(tx, ADMISSION_FAMILY);
      if (control.backend !== 'pg-boss') throw new Error('Admission producer fenced');
      const jobs: {
        group_id: string;
        job_id: string;
        reopened_via: 'unknown' | 'applied_conflict';
        old_snapshot: {
          unit: string;
          input_digest: string;
          state: string;
          application_sha256: string | null;
        };
      }[] = [];
      for (const row of rows) {
        const { root, lifecycle } = await lockAdmissionGroup(tx, row.group_id);
        if (
          !root ||
          root.parent_question_id ||
          !lifecycle ||
          !lifecycle.current_revision_id ||
          lifecycle.withdrawn ||
          lifecycle.suspended ||
          lifecycle.scoring_admission_state !== 'withheld'
        )
          throw new Error(`Not an eligible withheld group: ${row.group_id}`);
        const effects = await tx
          .select()
          .from(paid_effect)
          .where(
            and(eq(paid_effect.family, ADMISSION_FAMILY), eq(paid_effect.entity_id, row.group_id)),
          )
          .for('update');
        const old = effects.find(
          (effect) =>
            effect.unit === PREVIOUS_QUESTION_ADMISSION_PAID_UNIT &&
            effect.entity_revision === row.base_digest &&
            effect.input_digest === row.input_digest,
        );
        // Snapshot the exact old row BEFORE any re-pend mutation; the row itself
        // is never updated — this snapshot is the post-run comparison evidence.
        const oldSnapshot = old
          ? {
              unit: old.unit,
              input_digest: old.input_digest,
              state: old.state,
              application_sha256: old.application_json == null ? null : hash(old.application_json),
            }
          : null;
        const reopenedState =
          old?.state === 'unknown'
            ? ('unknown' as const)
            : old?.state === 'applied' && isKindMismatchSolveConflict(old.application_json)
              ? ('applied_conflict' as const)
              : null;
        if (
          reopenedState == null ||
          effects.some((effect) => effect.unit === QUESTION_ADMISSION_PAID_UNIT) ||
          effects.some(
            (effect) =>
              effect.entity_revision === row.base_digest &&
              QUESTION_ADMISSION_PAID_UNITS.includes(
                effect.unit as (typeof QUESTION_ADMISSION_PAID_UNITS)[number],
              ) &&
              effect.state === 'applied' &&
              !(effect.unit === old?.unit && effect.input_digest === old?.input_digest),
          )
        )
          throw new Error(
            `Missing exact old @2 row (unknown or applied kind-mismatch conflict), existing @3, or another known verdict: ${row.group_id}`,
          );
        const [revision] = await tx
          .select()
          .from(question_revision)
          .where(eq(question_revision.revision_id, lifecycle.current_revision_id));
        if (
          !revision ||
          revision.group_id !== row.group_id ||
          revision.integrity_digest !== row.base_digest
        )
          throw new Error('Current revision/base mismatch');
        const seal = publishedContractSeal({
          structure: revision.structure,
          response_spec: revision.response_spec,
          scoring_basis: revision.scoring_basis,
          execution_plan: revision.execution_plan,
          ...(revision.presentation != null ? { presentation: revision.presentation } : {}),
        });
        if (!publishedSealAccepts(seal, row.base_digest))
          throw new Error('Published digest mismatch');
        const layers = seal.parsed;
        let generation = lifecycle.scoring_admission_generation;
        for (const reason of ['owner_hold', 'unverified_rules'] as const) {
          if (
            reason === 'owner_hold' &&
            lifecycle.scoring_admission_withheld_reason === 'owner_hold'
          )
            continue;
          const published = await publishQuestionGroup(tx, {
            group_id: row.group_id,
            contract: { ...layers, integrity_digest: row.base_digest },
            expectedCurrentRevision: revision.revision_id,
            expectedAdmissionGeneration: generation,
            availability: lifecycle.availability,
            admission: { state: 'withheld', reason },
            actorRef: 'owner:yuk1547-approved-reopen',
            now: new Date(),
            readAssetBytes: (key) => getR2().get(key),
          });
          if (
            published.status !== 'admission_updated' ||
            published.current_revision_id !== revision.revision_id
          )
            throw new Error('Reopen must be a dimension-only update');
          generation = published.admission_generation;
        }
        const id = admissionJobId(
          row.group_id,
          revision.revision_id,
          row.base_digest,
          generation,
          row.input_digest,
        );
        const queued = await boss.send(
          ADMISSION_FAMILY,
          {
            admission_version: 3,
            question_id: row.group_id,
            revision_id: revision.revision_id,
            expected_revision_digest: row.base_digest,
            expected_admission_generation: generation,
            dispatch_generation: control.generation,
            reopen_paid_effect_identity: {
              unit: 'admission@2',
              input_digest: row.input_digest,
            },
          },
          { id, db: practiceBossTransaction(tx) },
        );
        if (queued === null)
          throw new Error('Marked job already exists; inspect instead of replaying');
        jobs.push({
          group_id: row.group_id,
          job_id: id,
          reopened_via: reopenedState,
          old_snapshot: oldSnapshot as NonNullable<typeof oldSnapshot>,
        });
      }
      return jobs;
    });
    console.log(JSON.stringify({ enqueued: jobs, old_paid_rows: 'untouched' }));
  } finally {
    await boss.stop();
    await db.$client.end();
  }
}

const [mode, path, manifestPath] = process.argv.slice(2);
if (mode === '--help')
  console.log(
    'TEST only: --preflight <new-receipt.json> OR --reopen-approved-five <receipt.json> <private-five-identities.json>. Preflight sends one probe per admission mode (solve per distinct resolved solver lane + one source_crosscheck on the primary lane) using the shared capability-driven submit wire policy. Never retries; no Docker.',
  );
else {
  const run =
    mode === '--preflight' && path
      ? preflight(path)
      : mode === '--reopen-approved-five' && path && manifestPath
        ? reopen(path, manifestPath)
        : Promise.reject(new Error('Use --help; explicit mode and paths are required'));
  run
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeHydratedDb?.().catch(() => {});
    });
}
