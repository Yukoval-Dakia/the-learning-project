// Lead-only TEST operation. No automatic caller; no tests or Docker operations.
// Preflight sends ONE provider request outside paid_effect. --plan is a dry,
// read-only eligibility evaluation that freezes the void+reauthorization
// manifest. This script NEVER enqueues jobs, republishes, or mutates
// paid_effect — the backlog driver releases each authorized group inside its
// own per-question gate (STOP / queue / unknown-rate / budget), so nothing
// becomes consumable before its turn.
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Provider } from '@/ai/task-spec';
import { evaluateAdmissionVoidGroup } from '@/capabilities/practice/server/admission/reauthorization';
import { QUESTION_ADMISSION_TASK_KIND } from '@/capabilities/practice/server/admission/solve';
import {
  QuestionAdmissionSolveInput,
  QuestionAdmissionSourceCrosscheckInput,
  QuestionAdmissionSourceCrosscheckOutput,
  parseQuestionAdmissionSolveModelOutput,
  questionAdmissionSolveTaskSpec,
} from '@/capabilities/practice/tasks/question-admission-solve';
import { getTaskSystemPrompt } from '@/capabilities/task-registry';
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
      if (native?.api !== 'openai-completions' || !native.baseUrl) {
        throw new Error('Require an OpenAI-completions model with a known catalog endpoint');
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
// ─── generic void + successor reauthorization planning (YUK-1567) ───────────

function requireTestDb(): void {
  if (
    !process.env.DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.YUK1547_TEST_DATABASE_URL
  ) {
    throw new Error('Explicitly set YUK1547_TEST_DATABASE_URL to the approved TEST DATABASE_URL');
  }
}

/**
 * Operator-authored void manifest: every 'unknown' blocker on each group must
 * be named explicitly (unit + input digest + the fence CAS token read at
 * manifest time). The successor unit is declared per group; the plan freezes
 * the successor's full identity + bound job id from the post-repend
 * generation. NO mutation happens here — the backlog driver performs each
 * release itself inside its per-question gate (STOP / queue / unknown-rate /
 * budget), so nothing becomes consumable before its gate turn.
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

/**
 * --plan: dry, read-only eligibility evaluation that freezes the
 * authorization manifest the driver consumes via --authorized. The frozen
 * `successor.input` is audit evidence; the driver re-derives the input under
 * locks at release time and refuses to proceed on any digest/generation/job-id
 * drift.
 */
async function plan(manifestPath: string, outPath: string) {
  requireTestDb();
  const manifest = reopenManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const { db } = await import('@/db/client');
  try {
    const groups = await db.transaction(async (tx) => {
      const evaluated: {
        spec: ReopenManifest['groups'][number];
        eval: Awaited<ReturnType<typeof evaluateAdmissionVoidGroup>>;
      }[] = [];
      for (const spec of manifest.groups) {
        evaluated.push({
          spec,
          eval: await evaluateAdmissionVoidGroup(tx, {
            groupId: spec.group_id,
            baseDigest: spec.base_digest,
            successorUnit: spec.successor_unit,
            void: spec.void.map((v) => ({
              unit: v.unit,
              inputDigest: v.input_digest,
              expectedFence: v.expected_fence,
            })),
          }),
        });
      }
      return evaluated;
    });
    const eligible = groups.every((g) => g.eval.failures.length === 0);
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
      groups: groups.map(({ spec, eval: g }) => ({
        group_id: spec.group_id,
        base_digest: spec.base_digest,
        successor_unit: spec.successor_unit,
        eligible: g.failures.length === 0,
        failures: g.failures,
        void: spec.void,
        republish_generations: g.republishGenerations,
        final_generation: g.finalGeneration,
        ghost_generations: g.ghostGenerations,
        revision_id: g.revisionId ?? '',
        successor:
          g.successorInputDigest != null && g.jobId != null
            ? {
                unit: spec.successor_unit,
                entity_revision: spec.base_digest,
                input_digest: g.successorInputDigest,
                job_id: g.jobId,
                input: g.successorInput,
              }
            : null,
        ghost_job_ids: g.ghostJobIds,
      })),
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
          'TEST only: --preflight <new-receipt.json> | --plan <manifest.json> --out <plan.json>. ' +
            'Preflight sends one probe per admission mode (solve per distinct resolved solver lane + one source_crosscheck on the primary lane). ' +
            '--plan is read-only and freezes the void+reauthorization manifest for the backlog driver ' +
            '(drive --authorized <plan.json> releases each group inside its per-question gates). ' +
            'This script never enqueues jobs or mutates paid_effect. Never retries; no Docker.',
        ),
      )
    : mode === '--preflight' && positional
      ? preflight(positional)
      : mode === '--plan' && positional && flags.out
        ? plan(positional, flags.out)
        : Promise.reject(new Error('Use --help; explicit mode and paths are required'));
run
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeHydratedDb?.().catch(() => {});
  });
