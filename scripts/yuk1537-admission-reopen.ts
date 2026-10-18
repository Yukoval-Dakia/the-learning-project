// Lead-only TEST operation. No automatic caller; no tests or Docker operations.
// Preflight sends ONE provider request outside paid_effect. Reopen atomically
// re-pends and enqueues exactly five explicitly named @1 unknown identities.
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Provider } from '@/ai/task-spec';
import {
  ADMISSION_FAMILY,
  admissionJobId,
  lockAdmissionGroup,
} from '@/capabilities/practice/server/admission/enqueue';
import {
  QuestionAdmissionSolveOutput,
  questionAdmissionSolveTaskSpec,
} from '@/capabilities/practice/tasks/question-admission-solve';
import {
  LEGACY_QUESTION_ADMISSION_PAID_UNIT,
  QUESTION_ADMISSION_PAID_UNITS,
} from '@/core/question-admission-policy';
import { zodToJsonSchemaCompat } from '@/kernel/zod-json-schema';
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
const schema = zodToJsonSchemaCompat(
  z.object({
    result: questionAdmissionSolveTaskSpec.definition.structuredOutputSchema,
  }),
  { io: 'input', reused: 'inline', target: 'draft-07' },
);

function routing() {
  if (
    process.env.AI_PROVIDER_OVERRIDE !== 'xiaomi-token-plan' ||
    process.env.AI_PROVIDER_MODEL !== 'mimo-v2.6-pro'
  ) {
    throw new Error('Require TEST app/worker pin xiaomi-token-plan / mimo-v2.6-pro');
  }
  if (process.env.QUESTION_ADMISSION_POLICY_ID?.trim().endsWith('@1')) {
    throw new Error('Remove obsolete QUESTION_ADMISSION_POLICY_ID @1 pin before spending');
  }
  const solver2Provider = process.env.QUESTION_ADMISSION_SOLVER2_PROVIDER;
  const solver2Model = process.env.QUESTION_ADMISSION_SOLVER2_MODEL;
  if (solver2Provider || solver2Model) {
    const model = nativePiModel(
      (solver2Provider || 'xiaomi-token-plan') as Provider,
      solver2Model || 'mimo-v2.6-pro',
    );
    if (model?.api !== 'openai-completions') {
      throw new Error('Second solver must be unset or resolve to an OpenAI-completions model');
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
              'Solve this synthetic preflight only: 1+1. Submit one result with scoring_unit_id u, status solved, answer kind blank_numeric, expected 2, tolerance absolute 0, equivalent_forms [], typical_wrong []. Use the submit tool exactly once.',
          },
          {
            role: 'user',
            content: 'What is 1+1? scoring_unit_id=u. No other question is supplied.',
          },
        ],
        tools: [
          {
            type: 'function',
            function: { name: submit, description: 'Submit result', parameters: schema },
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
    const args = JSON.parse(calls[0].function.arguments ?? '');
    const output = QuestionAdmissionSolveOutput.parse(args.result);
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
    process.env.DATABASE_URL !== process.env.YUK1537_TEST_DATABASE_URL
  ) {
    throw new Error('Explicitly set YUK1537_TEST_DATABASE_URL to the approved TEST DATABASE_URL');
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
      const control = await readPaidEffectControl(tx, ADMISSION_FAMILY);
      if (control.backend !== 'pg-boss') throw new Error('Admission producer fenced');
      const jobs: { group_id: string; job_id: string }[] = [];
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
            effect.unit === LEGACY_QUESTION_ADMISSION_PAID_UNIT &&
            effect.entity_revision === row.base_digest &&
            effect.input_digest === row.input_digest &&
            effect.state === 'unknown',
        );
        if (
          !old ||
          effects.some((effect) => effect.unit === 'admission@2') ||
          effects.some(
            (effect) =>
              effect.entity_revision === row.base_digest &&
              QUESTION_ADMISSION_PAID_UNITS.includes(
                effect.unit as 'admission@1' | 'admission@2',
              ) &&
              effect.state === 'applied',
          )
        )
          throw new Error(
            `Missing exact old unknown, existing @2, or known verdict: ${row.group_id}`,
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
            actorRef: 'owner:yuk1537-approved-reopen',
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
            admission_version: 2,
            question_id: row.group_id,
            revision_id: revision.revision_id,
            expected_revision_digest: row.base_digest,
            expected_admission_generation: generation,
            dispatch_generation: control.generation,
            reopen_unknown_input_digest: row.input_digest,
          },
          { id, db: practiceBossTransaction(tx) },
        );
        if (queued === null)
          throw new Error('Marked job already exists; inspect instead of replaying');
        jobs.push({ group_id: row.group_id, job_id: id });
      }
      return jobs;
    });
    console.log(JSON.stringify({ enqueued: jobs, old_unknown_rows: 'untouched' }));
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
