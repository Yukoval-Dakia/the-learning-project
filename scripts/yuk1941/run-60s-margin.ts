// YUK-1941 round 2 — prior @60s timeout / 15s correction margin (predeclared calls).
// Calls: A admission q1 @60/15 (3 calls) | B prior q1 (1) | C prior q3 x2 (2)
// | D admission q1 @25s/5s forced timeout kill (3) | E prior q4 three-part (1)
// = 10 calls, est ~$0.012-0.02, hard stop $0.05 cumulative.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { definitionFromContract } from '@/capabilities/practice/question-bank/server/admission/definition-from-contract';
import { runQuestionAdmission } from '@/capabilities/practice/question-bank/server/admission/run-admission';
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
const LOG = join(OUT_DIR, 'round2-60s.jsonl');

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
  groupId: 'yuk1941-r2-q1',
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
  groupId: 'yuk1941-r2-q3',
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
  groupId: 'yuk1941-r2-q4',
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
  const realFetch = globalThis.fetch;
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
  });
  const resolved = resolveTaskProvider(QUESTION_ADMISSION_TASK_KIND as never);
  console.log(`route: ${resolved.provider}/${resolved.model} auth=${resolved.authMode}`);
  const runTask = makeRunTaskTextFn(db);
  const defs = {
    q1: definitionFromContract(Q1),
    q3: definitionFromContract(Q3),
    q4: definitionFromContract(Q4),
  };
  let spendTotal = 0;

  const rec = (o: Record<string, unknown>) => {
    appendFileSync(LOG, `${JSON.stringify(o)}\n`);
    if (typeof o.cost_usd === 'number') spendTotal += o.cost_usd;
    if (spendTotal >= 0.05) throw new Error(`spend cap $${spendTotal.toFixed(4)}`);
  };
  const budgetOf = async (id: string | null) => {
    if (!id) return null;
    const [r] = await db.select().from(ai_task_runs).where(eq(ai_task_runs.id, id)).limit(1);
    const u = (r?.usage_json ?? {}) as Record<string, unknown>;
    return {
      budget: (u.transport as Record<string, unknown> | undefined)?.budget ?? null,
      out: u.outputTokens ?? null,
      turns: u.numTurns ?? null,
      cost: r?.cost_usd ?? null,
    };
  };

  // A: admission q1 @60s/15s
  setTestConfig({
    [SOLUTION_PRIOR_TIMEOUT_CONFIG_KEY]: 60_000,
    [SOLUTION_PRIOR_CORRECTION_MARGIN_CONFIG_KEY]: 15_000,
  });
  {
    const t0 = Date.now();
    const res = await runQuestionAdmission(defs.q1, { db, runTask });
    const spp = res.verification.evidence.solution_prior_pass as {
      status?: string;
      task_run_id?: string | null;
      reason?: string;
    } | null;
    const budgets: Record<string, unknown> = {};
    for (const id of [...res.evidence_refs.task_run_ids, spp?.task_run_id].filter(
      Boolean,
    ) as string[]) {
      const b = await budgetOf(id);
      budgets[id] = b?.budget;
      rec({
        phase: 'A',
        role: 'admission-call',
        task_run_id: id,
        cost_usd: b?.cost,
        out_tokens: b?.out,
        turns: b?.turns,
        transport_budget: b?.budget,
      });
    }
    rec({
      phase: 'A',
      role: 'admission',
      status: res.status,
      prior_status: spp?.status,
      has_prior: res.solution_prior != null,
      wall_ms: Date.now() - t0,
    });
    console.log(
      `[A] status=${res.status} prior=${spp?.status} hasPrior=${res.solution_prior != null} budgets=${JSON.stringify(Object.values(budgets).map((b) => (b as { timeout_source?: string; task_timeout_ms?: number })?.timeout_source + ':' + (b as { task_timeout_ms?: number })?.task_timeout_ms))}`,
    );
  }
  // B: prior q1 @60/15
  {
    const t0 = Date.now();
    const p = await runSolutionPriorPass(db, defs.q1, settledKeysFromDefinition(defs.q1), {
      runTask,
      knowledgeCandidates: [],
    });
    const b = await budgetOf(p.outcome.task_run_id);
    rec({
      phase: 'B',
      question: 'q1',
      outcome: p.outcome,
      produced: p.record != null,
      wall_ms: Date.now() - t0,
      task_run_id: p.outcome.task_run_id,
      ...b,
    });
    console.log(
      `[B] q1 ${p.outcome.status} produced=${p.record != null} wall=${((Date.now() - t0) / 1000).toFixed(1)}s turns=${b?.turns}`,
    );
  }
  // C: prior q3 x2 @60/15
  for (let rep = 1; rep <= 2; rep++) {
    const t0 = Date.now();
    const p = await runSolutionPriorPass(db, defs.q3, settledKeysFromDefinition(defs.q3), {
      runTask,
      knowledgeCandidates: [],
    });
    const b = await budgetOf(p.outcome.task_run_id);
    rec({
      phase: 'C',
      rep,
      question: 'q3',
      outcome: p.outcome,
      produced: p.record != null,
      parts: p.record?.parts?.map((x) => x.part_id) ?? null,
      wall_ms: Date.now() - t0,
      task_run_id: p.outcome.task_run_id,
      ...b,
    });
    console.log(
      `[C] q3-r${rep} ${p.outcome.status} produced=${p.record != null} wall=${((Date.now() - t0) / 1000).toFixed(1)}s turns=${b?.turns} reason=${(p.outcome.reason ?? '').slice(0, 90)}`,
    );
  }
  // D: admission q1 @25s/5s — forced timeout kill, expect still admitted
  setTestConfig({
    [SOLUTION_PRIOR_TIMEOUT_CONFIG_KEY]: 25_000,
    [SOLUTION_PRIOR_CORRECTION_MARGIN_CONFIG_KEY]: 5_000,
  });
  {
    const t0 = Date.now();
    const res = await runQuestionAdmission(defs.q1, { db, runTask });
    const spp = res.verification.evidence.solution_prior_pass as {
      status?: string;
      reason?: string;
      task_run_id?: string | null;
    } | null;
    for (const id of [...res.evidence_refs.task_run_ids, spp?.task_run_id].filter(
      Boolean,
    ) as string[]) {
      const b = await budgetOf(id);
      rec({
        phase: 'D',
        role: 'admission-call',
        task_run_id: id,
        cost_usd: b?.cost,
        transport_budget: b?.budget,
      });
    }
    rec({
      phase: 'D',
      role: 'admission',
      status: res.status,
      prior_status: spp?.status,
      prior_reason: spp?.reason?.slice(0, 200),
      has_prior: res.solution_prior != null,
      wall_ms: Date.now() - t0,
    });
    console.log(
      `[D] status=${res.status} prior=${spp?.status} reason=${(spp?.reason ?? '').slice(0, 80)}`,
    );
  }
  // E: prior q4 three-part @60/15
  setTestConfig({
    [SOLUTION_PRIOR_TIMEOUT_CONFIG_KEY]: 60_000,
    [SOLUTION_PRIOR_CORRECTION_MARGIN_CONFIG_KEY]: 15_000,
  });
  {
    const t0 = Date.now();
    const p = await runSolutionPriorPass(db, defs.q4, settledKeysFromDefinition(defs.q4), {
      runTask,
      knowledgeCandidates: [],
    });
    const b = await budgetOf(p.outcome.task_run_id);
    rec({
      phase: 'E',
      question: 'q4-3part',
      outcome: p.outcome,
      produced: p.record != null,
      parts: p.record?.parts?.map((x) => x.part_id) ?? null,
      wall_ms: Date.now() - t0,
      task_run_id: p.outcome.task_run_id,
      ...b,
    });
    console.log(
      `[E] q4 ${p.outcome.status} produced=${p.record != null} parts=${JSON.stringify(p.record?.parts?.map((x) => x.part_id))} wall=${((Date.now() - t0) / 1000).toFixed(1)}s turns=${b?.turns} reason=${(p.outcome.reason ?? '').slice(0, 90)}`,
    );
  }
  console.log(`done totalSpend=$${spendTotal.toFixed(4)}`);
  await sql.end({ timeout: 5 });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
