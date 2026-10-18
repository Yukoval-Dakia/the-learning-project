// Lead-only TEST operation. No automatic caller; no tests or Docker operations.
// Preflight sends ONE provider request outside paid_effect. Reopen atomically
// re-pends and enqueues exactly five explicitly named @2 identities —
// admission@2 rows in state 'unknown', or the single @2 applied row whose
// verdict withheld on the blank_text-vs-blank_numeric kind-mismatch conflict.
// Old paid rows are never updated; the marked @3 jobs carry the exact old row
// identity (unit + input digest) as reopen_paid_effect_identity.
import { createHash } from 'node:crypto';
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
import {
  parseQuestionAdmissionSolveModelOutput,
  questionAdmissionSolveTaskSpec,
} from '@/capabilities/practice/tasks/question-admission-solve';
import {
  LEGACY_QUESTION_ADMISSION_PAID_UNIT,
  PREVIOUS_QUESTION_ADMISSION_PAID_UNIT,
  QUESTION_ADMISSION_PAID_UNIT,
  QUESTION_ADMISSION_PAID_UNITS,
} from '@/core/question-admission-policy';
import { zodToJsonSchemaCompat } from '@/kernel/zod-json-schema';
import { assertModelProfileCapabilityFit } from '@/server/ai/model-profiles';
import { nativePiModel } from '@/server/ai/pi-provider-catalog';
import { xiaomiTokenPlanBaseUrl } from '@/server/ai/xiaomi-token-plan';

const submit = 'mcp__structured_output__submit';
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
const schema = zodToJsonSchemaCompat(
  questionAdmissionSolveTaskSpec.definition.structuredOutputSchema,
  {
    io: 'input',
    reused: 'inline',
    target: 'draft-07',
  },
);

function routing() {
  if (
    process.env.AI_PROVIDER_OVERRIDE !== 'xiaomi-token-plan' ||
    process.env.AI_PROVIDER_MODEL !== 'mimo-v2.6-pro'
  ) {
    throw new Error('Require TEST app/worker pin xiaomi-token-plan / mimo-v2.6-pro');
  }
  const policyPin = process.env.QUESTION_ADMISSION_POLICY_ID?.trim();
  if (policyPin?.endsWith('@1') || policyPin?.endsWith('@2')) {
    throw new Error('Remove obsolete QUESTION_ADMISSION_POLICY_ID @1/@2 pin before deploy');
  }
  const solver2Provider = process.env.QUESTION_ADMISSION_SOLVER2_PROVIDER;
  const solver2Model = process.env.QUESTION_ADMISSION_SOLVER2_MODEL;
  for (const [solver, provider, model] of [
    ['Solver A', 'xiaomi-token-plan', 'mimo-v2.6-pro'],
    [
      'Solver B',
      (solver2Provider || 'xiaomi-token-plan') as Provider,
      solver2Model || 'mimo-v2.6-pro',
    ],
  ] as const) {
    try {
      assertModelProfileCapabilityFit(questionAdmissionSolveTaskSpec.definition, provider, model);
      if (nativePiModel(provider, model)?.api !== 'openai-completions') {
        throw new Error('Require an OpenAI-completions model');
      }
    } catch (error) {
      throw new Error(
        `${solver} routing refused before re-pend: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    provider: 'xiaomi-token-plan',
    model: 'mimo-v2.6-pro',
    endpoint: xiaomiTokenPlanBaseUrl(),
    solver2Provider,
    solver2Model,
    policy: process.env.QUESTION_ADMISSION_POLICY_ID,
  };
}

async function preflight(path: string) {
  const route = routing();
  const key = process.env.XIAOMI_TOKEN_PLAN_API_KEY;
  if (!key) throw new Error('Missing Token Plan key');
  // Refuse an existing receipt BEFORE the single request. Failed attempts also
  // leave a receipt; this command never retries, overwrites, or reopens a claim.
  const file = await open(path, 'wx');
  const receipt: Record<string, unknown> = {
    passed: false,
    created_at: new Date().toISOString(),
    routing_hash: hash(route),
    schema_hash: hash(schema),
    outside_paid_effect: true,
  };
  try {
    const response = await fetch(`${route.endpoint}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: route.model,
        max_tokens: 4096,
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              'Solve this synthetic preflight only: 1+1. Use the submit tool exactly once with arguments {"units":[{"scoring_unit_id":"u","status":"solved","answer":{"kind":"blank_numeric","expected":2,"tolerance":{"kind":"absolute","value":0}},"equivalent_forms":[],"typical_wrong":[]}]}. The arguments ARE the output object: units sits at top level, no result field.',
          },
          {
            role: 'user',
            content: 'What is 1+1? scoring_unit_id=u. No other question is supplied.',
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: submit,
              description: 'Submit the structured output object',
              parameters: schema,
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: submit } },
        parallel_tool_calls: false,
      }),
    });
    receipt.http_status = response.status;
    if (response.status !== 200)
      throw new Error(`Preflight HTTP ${response.status}; stop before reopening`);
    const body = (await response.json()) as {
      id?: string;
      usage?: unknown;
      choices?: {
        finish_reason?: string;
        message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] };
      }[];
    };
    receipt.provider_request_id = body.id;
    receipt.usage = body.usage ?? null;
    const calls = body.choices?.[0]?.message?.tool_calls;
    if (
      body.choices?.length !== 1 ||
      body.choices[0].finish_reason !== 'tool_calls' ||
      calls?.length !== 1 ||
      calls[0].function?.name !== submit
    ) {
      throw new Error('Preflight requires exactly one choice and one completed submit call');
    }
    const rawArguments = calls[0].function.arguments ?? '';
    // Synthetic 1+1 probe only, no question text or credentials: keep the raw
    // arguments so a failed probe can be diagnosed without a second request.
    receipt.raw_arguments = rawArguments.slice(0, 8000);
    const args: unknown = JSON.parse(rawArguments);
    receipt.arguments_was_string = typeof args === 'string';
    // Same parse entry as the solve path (string tolerated at this level), with
    // the repair budget at zero so the probe proves strict schema validity.
    const output = parseQuestionAdmissionSolveModelOutput(args, [], { remaining: 0 });
    const answer = output.units[0]?.answer;
    if (
      output.units.length !== 1 ||
      output.units[0].scoring_unit_id !== 'u' ||
      output.units[0].status !== 'solved' ||
      answer?.kind !== 'blank_numeric' ||
      answer.expected !== 2
    )
      throw new Error('Invalid preflight synthetic answer');
    receipt.output = output;
    receipt.passed = true;
    console.log('PASS: HTTP 200; exactly one submit call; strict schema; no paid_effect created');
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await file.writeFile(JSON.stringify(receipt, null, 2));
    await file.close();
  }
}

async function reopen(receiptPath: string, manifestPath: string) {
  const route = routing();
  const receipt = z
    .object({
      passed: z.literal(true),
      http_status: z.literal(200),
      created_at: z.string().datetime(),
      routing_hash: z.string(),
      schema_hash: z.string(),
    })
    .parse(JSON.parse(await readFile(receiptPath, 'utf8')));
  const age = Date.now() - Date.parse(receipt.created_at);
  if (
    age < 0 ||
    age > 60 * 60_000 ||
    receipt.routing_hash !== hash(route) ||
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
    'TEST only: --preflight <new-receipt.json> OR --reopen-approved-five <receipt.json> <private-five-identities.json>. Never retries; no Docker.',
  );
else {
  const run =
    mode === '--preflight' && path
      ? preflight(path)
      : mode === '--reopen-approved-five' && path && manifestPath
        ? reopen(path, manifestPath)
        : Promise.reject(new Error('Use --help; explicit mode and paths are required'));
  run.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
