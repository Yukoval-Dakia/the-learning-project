// YUK-1941 diagnosis — prior at TEST-equivalent 300s timeout / 60s shared margin,
// stream capture per call. Predeclared: q1x3, q3x3, q4x2 = 8 calls, cap $0.10.
// No short timeout: let the model finish (or run away) on its own.
import { appendFileSync, createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { definitionFromContract } from '@/capabilities/practice/question-bank/server/admission/definition-from-contract';
import {
  QUESTION_ADMISSION_TASK_KIND,
  SOLUTION_PRIOR_CORRECTION_MARGIN_CONFIG_KEY,
  SOLUTION_PRIOR_TIMEOUT_CONFIG_KEY,
  runSolutionPriorPass,
  settledKeysFromDefinition,
} from '@/capabilities/practice/question-bank/server/admission/solve';
import { installCustomProviders } from '@/core/config/custom-providers';
import { setTestConfig } from '@/core/config/store';
import * as schema from '@/db/schema';
import { ai_task_runs } from '@/db/schema';
import {
  type NormalizedContract,
  contractIntegrityDigest,
} from '@/kernel/records/assessment-normalization';
import { refreshModelCatalog } from '@/server/ai/model-catalog';
import { resolveTaskProvider } from '@/server/ai/providers';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';

const OUT_DIR = process.env.YUK1941_OUT as string;
mkdirSync(OUT_DIR, { recursive: true });
const LOG = join(OUT_DIR, 'diag-runs.jsonl');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.includes('127.0.0.1:5434')) throw new Error('dev DB only');
if (process.env.DEV_ALLOW_TEST_DB === '1') throw new Error('prohibited');
if (process.env.AI_PROVIDER_OVERRIDE || process.env.AI_PROVIDER_MODEL)
  throw new Error('pin env set');
for (const l of readFileSync(join(homedir(), '.config', 'tlp', 'dev-secrets.env'), 'utf8').split(
  '\n',
)) {
  const m = l.match(/^\s*(?:export\s+)?OPENDESIGN_API_KEY\s*=\s*(.+?)\s*$/);
  if (m) process.env.OPENDESIGN_API_KEY = m[1].replace(/^['"]|['"]$/g, '');
}
if (!process.env.OPENDESIGN_API_KEY) throw new Error('no key');

// ---------- stream capture ----------
const realFetch = globalThis.fetch;
let captureArm: {
  name: string;
  started: number;
  meta: ReturnType<typeof createWriteStream>;
  raw: ReturnType<typeof createWriteStream>;
} | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await realFetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const arm = captureArm;
  if (arm == null || !url.includes('open-design.ai')) return res;
  const body = res.body;
  if (body == null) return res;
  const [a, b] = body.tee();
  void (async () => {
    const reader = b.getReader();
    let cum = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        cum += value.byteLength;
        arm.meta.write(
          `${JSON.stringify({ t_ms: Date.now() - arm.started, n: value.byteLength, cum })}\n`,
        );
        arm.raw.write(Buffer.from(value));
      }
      arm.meta.write(`${JSON.stringify({ t_ms: Date.now() - arm.started, done: true, cum })}\n`);
    } catch (error) {
      arm.meta.write(
        `${JSON.stringify({ t_ms: Date.now() - arm.started, err: String(error), cum })}\n`,
      );
    }
    arm.meta.end();
    arm.raw.end();
  })();
  return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
}) as typeof fetch;
function armCapture(name: string): void {
  captureArm = {
    name,
    started: Date.now(),
    meta: createWriteStream(join(OUT_DIR, `stream-${name}.meta.jsonl`)),
    raw: createWriteStream(join(OUT_DIR, `stream-${name}.raw.txt`)),
  };
}

function contractFor(input: {
  groupId: string;
  parts: { part_id: string; question_no?: string; prompt_md: string }[];
  slots: Record<string, unknown>[];
  units: Record<string, unknown>[];
}): NormalizedContract {
  const structure = {
    group_id: input.groupId,
    materials: [],
    parts: input.parts.map((p) => ({ ...p, material_ids: [] })),
  };
  const response_spec = { slots: input.slots };
  const scoring_basis = {
    units: input.units.map((u) => ({
      material_refs: [],
      evidence_slot_refs: [],
      requires_group_evidence: false,
      ...u,
    })),
    aggregation: { kind: 'sum' },
    blank_scores_zero: true,
  };
  const execution_plan = {
    plan_version: 1,
    assignments: input.units.map((u) => ({
      scoring_unit_ids: [u.scoring_unit_id as string],
      executor: {
        kind: 'model_executor',
        task_kind: 'AssessmentRuleJudgeTask',
        admitted_slice_id: null,
      },
    })),
    escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'pending' },
  };
  const layers = { structure, response_spec, scoring_basis, execution_plan };
  return {
    ...layers,
    integrity_digest: contractIntegrityDigest(layers),
    group_id: input.groupId,
    conversion_issues: [],
  } as unknown as NormalizedContract;
}

const Q1 = contractFor({
  groupId: 'yuk1941-d-q1',
  parts: [
    {
      part_id: 'q1p1',
      prompt_md: '已知等差数列 $\\{a_n\\}$ 满足 $a_2 = 3$，$a_5 = 12$。求该数列的公差 $d$。',
    },
  ],
  slots: [{ slot_id: 'q1s1', part_id: 'q1p1', kind: 'numeric' }],
  units: [
    {
      scoring_unit_id: 'q1u1',
      slot_refs: ['q1s1'],
      criterion: { kind: 'numeric_key', expected: 3, tolerance: { kind: 'absolute', value: 0 } },
      points: 5,
    },
  ],
});
const Q3 = contractFor({
  groupId: 'yuk1941-d-q3',
  parts: [
    {
      part_id: 'q3p1',
      question_no: '(1)',
      prompt_md:
        '已知函数 $f(x) = x^3 - 3x + m$，其中 $m$ 为常数。求 $f(x)$ 的极小值点 $x$ 的值（结果不含 $m$）。',
    },
    {
      part_id: 'q3p2',
      question_no: '(2)',
      prompt_md:
        '已知函数 $f(x) = x^3 - 3x + m$，其中 $m$ 为常数。若 $f(x)$ 恰有两个不同的实零点，求 $m$ 的所有可能取值。',
    },
  ],
  slots: [
    { slot_id: 'q3s1', part_id: 'q3p1', kind: 'text', math_preview: true },
    { slot_id: 'q3s2', part_id: 'q3p2', kind: 'text', math_preview: true },
  ],
  units: [
    {
      scoring_unit_id: 'q3u1',
      slot_refs: ['q3s1'],
      criterion: { kind: 'text_key', accepted_texts: ['x=1', '1'], normalization: 'trim' },
      points: 4,
    },
    {
      scoring_unit_id: 'q3u2',
      slot_refs: ['q3s2'],
      criterion: { kind: 'text_key', accepted_texts: ['m=2或m=-2', 'm=±2'], normalization: 'trim' },
      points: 6,
    },
  ],
});
const Q4 = contractFor({
  groupId: 'yuk1941-d-q4',
  parts: [
    {
      part_id: 'q4p1',
      question_no: '(1)',
      prompt_md: '设等比数列 $\\{b_n\\}$ 满足 $b_1=2$，$b_3=8$（公比为正）。求公比 $q$。',
    },
    {
      part_id: 'q4p2',
      question_no: '(2)',
      prompt_md: '设等比数列 $\\{b_n\\}$ 满足 $b_1=2$，$b_3=8$（公比为正）。求 $b_4$。',
    },
    {
      part_id: 'q4p3',
      question_no: '(3)',
      prompt_md: '设等比数列 $\\{b_n\\}$ 满足 $b_1=2$，$b_3=8$（公比为正）。求前 5 项和 $S_5$。',
    },
  ],
  slots: [
    { slot_id: 'q4s1', part_id: 'q4p1', kind: 'text', math_preview: true },
    { slot_id: 'q4s2', part_id: 'q4p2', kind: 'text', math_preview: true },
    { slot_id: 'q4s3', part_id: 'q4p3', kind: 'text', math_preview: true },
  ],
  units: [
    {
      scoring_unit_id: 'q4u1',
      slot_refs: ['q4s1'],
      criterion: { kind: 'text_key', accepted_texts: ['q=2', '2'], normalization: 'trim' },
      points: 3,
    },
    {
      scoring_unit_id: 'q4u2',
      slot_refs: ['q4s2'],
      criterion: { kind: 'text_key', accepted_texts: ['b4=16', '16'], normalization: 'trim' },
      points: 3,
    },
    {
      scoring_unit_id: 'q4u3',
      slot_refs: ['q4s3'],
      criterion: { kind: 'text_key', accepted_texts: ['S5=62', '62'], normalization: 'trim' },
      points: 4,
    },
  ],
});

async function main() {
  const sql = postgres(databaseUrl as string, { max: 4, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  const nowIso = new Date().toISOString();
  installCustomProviders([
    {
      id: 'custom:opendesign',
      displayName: 'OpenDesign',
      baseUrl: 'https://amr-link.open-design.ai/v1',
      apiKeyEnv: 'OPENDESIGN_API_KEY',
      protocol: 'openai-completions',
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  ]);
  const refresh = await refreshModelCatalog(db, {
    fetchCatalog: (async (u: string | URL, i?: RequestInit) => {
      const h = new URL(String(u)).hostname;
      if (!['models.dev', 'amr-link.open-design.ai'].includes(h)) throw new Error(`blocked ${h}`);
      return realFetch(u, i);
    }) as typeof fetch,
    env: { OPENDESIGN_API_KEY: process.env.OPENDESIGN_API_KEY },
  });
  console.log('catalog:', refresh.outcome);
  setTestConfig({
    [`task.${QUESTION_ADMISSION_TASK_KIND}.provider`]: 'custom:opendesign',
    [`task.${QUESTION_ADMISSION_TASK_KIND}.model`]: 'deepseek-v4.1-flash',
    [`task.${QUESTION_ADMISSION_TASK_KIND}.budget`]: { timeout: 300_000 },
    // TEST-equivalent semantics: 300s task window, shared 60s landing margin.
    [SOLUTION_PRIOR_TIMEOUT_CONFIG_KEY]: 300_000,
    [SOLUTION_PRIOR_CORRECTION_MARGIN_CONFIG_KEY]: 60_000,
  });
  const resolved = resolveTaskProvider(QUESTION_ADMISSION_TASK_KIND as never);
  console.log(`route: ${resolved.provider}/${resolved.model} auth=${resolved.authMode}`);
  console.log('predeclared: q1x3, q3x3, q4x2 = 8 prior calls @300s/60s-margin, cap $0.10');
  const runTask = makeRunTaskTextFn(db);
  const defs = {
    q1: definitionFromContract(Q1),
    q3: definitionFromContract(Q3),
    q4: definitionFromContract(Q4),
  };
  let spend = 0;
  const plan: [string, keyof typeof defs][] = [
    ['q1-r1', 'q1'],
    ['q1-r2', 'q1'],
    ['q1-r3', 'q1'],
    ['q3-r1', 'q3'],
    ['q3-r2', 'q3'],
    ['q3-r3', 'q3'],
    ['q4-r1', 'q4'],
    ['q4-r2', 'q4'],
  ];
  for (const [name, q] of plan) {
    armCapture(name);
    const t0 = Date.now();
    const p = await runSolutionPriorPass(db, defs[q], settledKeysFromDefinition(defs[q]), {
      runTask,
      knowledgeCandidates: [],
    });
    const wall = Date.now() - t0;
    captureArm = null;
    let usage: Record<string, unknown> = {};
    if (p.outcome.task_run_id) {
      const [r] = await db
        .select()
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, p.outcome.task_run_id))
        .limit(1);
      usage = (r?.usage_json ?? {}) as Record<string, unknown>;
      if (typeof r?.cost_usd === 'number') spend += r.cost_usd;
    }
    appendFileSync(
      LOG,
      `${JSON.stringify({ name, question: q, outcome: p.outcome, produced: p.record != null, parts: p.record?.parts?.map((x) => x.part_id) ?? null, wall_ms: wall, usage: { out: usage.outputTokens ?? null, in: usage.inputTokens ?? null, turns: usage.numTurns ?? null, thinking_chars: usage.thinkingCharacters ?? null } })}\n`,
    );
    console.log(
      `[${name}] ${p.outcome.status} produced=${p.record != null} wall=${(wall / 1000).toFixed(1)}s out=${usage.outputTokens ?? '?'} turns=${usage.numTurns ?? '?'} spend=$${spend.toFixed(4)} reason=${(p.outcome.reason ?? '').slice(0, 100)}`,
    );
    if (spend >= 0.1) {
      console.log('cap reached');
      break;
    }
  }
  console.log(`done totalSpend=$${spend.toFixed(4)}`);
  await sql.end({ timeout: 5 });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
