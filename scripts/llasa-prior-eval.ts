// scripts/llasa-prior-eval.ts
/**
 * YUK-376 — LLaSA 冷启锚离线 eval（actual-output，真实 provider 调用）。
 *
 * 目的：票面 gate「仅当日用中 llm_prior 的 b 噪声经验证过大才上」——本脚本对同一批
 * 真实题跑两种先验方法各 REPS 次，量化：
 *   1. 方法内重复运行方差（feature→b 的 b 噪声是否确实过大 —— gate 核心证据）；
 *   2. 两法分歧（|b_feature − b_llasa| 分布 + 秩相关）；
 *   3. 弱基准校准度：question.difficulty（owner 手填 1-5 序数）→ difficultyToLogitB
 *      映射后的 Spearman/Pearson（序数当 interval 是弱锚，仅作参考信号，见
 *      VERIFY:difficulty-logit-map）；以及现网已存 source='llm_prior' 行（同一
 *      方法的一次历史样本）vs 本次重跑的偏移。
 *
 * 读侧：只读 question / item_calibration / knowledge；写侧只有 runner 自身的
 * ai_task_run 留痕（生产同款）。不碰 item_calibration 写路径。
 *
 * Run:
 *   LLASA_EVAL=1 pnpm tsx scripts/llasa-prior-eval.ts            # 全真跑（默认 30 题 ×2 法 ×3 reps）
 *   LLASA_EVAL=1 LLASA_EVAL_LIMIT=6 LLASA_EVAL_REPS=2 pnpm tsx … # 缩小 sweep
 *   pnpm tsx scripts/llasa-prior-eval.ts --dry-run               # 只列样本不发请求
 *
 * Exit codes: 0 = 跑完（含 insufficient-data 诚实路径）；2 = 环境/DB 不可用。
 */

import './load-env'; // loads .env (XIAOMI_API_KEY 等) before @/db/client is constructed
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { difficultyToLogitB } from '@/core/theta';
import { ai_task_runs, item_calibration, knowledge, question } from '@/db/schema';
import { buildLocalDatabaseUrl } from './local-db-env';

// .env 的 DATABASE_URL 是 compose 内网地址（postgres:5432）；脚本跑在宿主机，
// 打到 dev DB 的 5433 映射口。容器内跑时（host 可解析）不干预。
if ((process.env.DATABASE_URL ?? '').includes('@postgres:')) {
  process.env.DATABASE_URL = buildLocalDatabaseUrl();
}

const { db } = await import('@/db/client');
const { resolveSubjectProfileForKnowledgeIds } = await import(
  '@/capabilities/practice/server/knowledge-runtime'
);
const { parseItemPriorLlasaOutput, parseItemPriorOutput } = await import('@/server/ai/item-prior');
const { makePracticeTaskRunFn } = await import('@/capabilities/practice/server/task-runtime');

const DRY_RUN = process.argv.includes('--dry-run');
const SAMPLE_LIMIT = Number(process.env.LLASA_EVAL_LIMIT ?? 30);
const REPS = Number(process.env.LLASA_EVAL_REPS ?? 3);
const CONCURRENCY = Number(process.env.LLASA_EVAL_CONCURRENCY ?? 4);
const EVIDENCE_PATH = join(
  process.cwd(),
  'docs/planning/evidence/2026-09-23-llasa-prior-eval-actual.json',
);
const METHODS = ['feature', 'llasa'] as const;
type Method = (typeof METHODS)[number];

interface SampleRow {
  id: string;
  kind: string;
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  knowledge_ids: string[];
  difficulty: number;
  stored_b: number | null;
  stored_source: string | null;
}

interface CallRecord {
  question_id: string;
  method: Method;
  rep: number;
  status: 'ok' | 'parse_failed' | 'run_failed';
  b_logit?: number;
  confidence?: number;
  censored?: 'low' | 'high' | null;
  monotone?: boolean;
  task_run_id?: string;
  cost_usd?: number;
  cost_basis?: string;
  input_digest: string;
  output_digest?: string;
  error?: string;
}

const sha256 = (text: string) =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

/** 分层抽样：按 kind 比例分配，每 kind 至少 1 道（有料的才计入），ORDER BY id 定序。 */
function stratifiedSample(rows: SampleRow[], limit: number): SampleRow[] {
  const byKind = new Map<string, SampleRow[]>();
  for (const r of rows) {
    const bucket = byKind.get(r.kind) ?? [];
    bucket.push(r);
    byKind.set(r.kind, bucket);
  }
  const picked: SampleRow[] = [];
  const quotas = [...byKind.entries()].map(([kind, list]) => ({
    kind,
    list,
    quota: Math.max(1, Math.round((list.length / rows.length) * limit)),
  }));
  for (const { list, quota } of quotas) picked.push(...list.slice(0, quota));
  // 超额则从大到小截断（保持 kind 顺序稳定）；不足不补——样本少时诚实报告。
  return picked.slice(0, limit);
}

function mean(xs: number[]): number {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function sd(xs: number[]): number {
  // n<2 时 within-question 方差未定义——返回 NaN 让下游 filter 丢弃，
  // 不能把「只有 0/1 次成功」当成 SD=0 的完美稳定。
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function pearson(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return Number.NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? Number.NaN : num / Math.sqrt(dx * dy);
}
function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const r = new Array<number>(xs.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].x === order[i].x) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k].i] = avg;
    i = j + 1;
  }
  return r;
}
const spearman = (xs: number[], ys: number[]) => pearson(ranks(xs), ranks(ys));
/** 相关分析前先丢 NaN 配对——NaN 参与 ranks 会得到任意名次而非被剔除。 */
const spearmanFinite = (xs: number[], ys: number[]) => {
  const pairs = xs
    .map((x, i) => [x, ys[i] ?? Number.NaN] as const)
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  return spearman(
    pairs.map(([x]) => x),
    pairs.map(([, y]) => y),
  );
};

async function runOne(
  runTaskFn: ReturnType<typeof makePracticeTaskRunFn>,
  row: SampleRow,
  kcNames: { name: string }[],
  subjectProfile: Awaited<ReturnType<typeof resolveSubjectProfileForKnowledgeIds>>,
  method: Method,
  rep: number,
): Promise<CallRecord> {
  const input =
    method === 'llasa'
      ? {
          prompt_md: row.prompt_md,
          kind: row.kind,
          knowledge_context: kcNames,
          reference_md: row.reference_md,
          choices_md: row.choices_md,
        }
      : { prompt_md: row.prompt_md, kind: row.kind, knowledge_context: kcNames };
  const inputDigest = sha256(`${method}:${JSON.stringify(input)}`);
  const base = { question_id: row.id, method, rep, input_digest: inputDigest };
  try {
    const result = await runTaskFn(
      method === 'llasa' ? 'ItemPriorLlasaTask' : 'ItemPriorTask',
      input,
      { subjectProfile },
    );
    const common = {
      ...base,
      task_run_id: result.task_run_id,
      cost_usd: result.cost_usd,
      cost_basis: result.cost_basis,
      output_digest: sha256(result.text),
    };
    try {
      if (method === 'llasa') {
        const { prior, inversion } = parseItemPriorLlasaOutput(result.text);
        return {
          ...common,
          status: 'ok',
          b_logit: prior.b_logit,
          confidence: prior.confidence,
          censored: inversion.censored,
          monotone: inversion.monotone,
        };
      }
      const draft = parseItemPriorOutput(result.text);
      return { ...common, status: 'ok', b_logit: draft.b_logit, confidence: draft.confidence };
    } catch (e) {
      return { ...common, status: 'parse_failed', error: (e as Error).message.slice(0, 300) };
    }
  } catch (e) {
    return { ...base, status: 'run_failed', error: (e as Error).message.slice(0, 300) };
  }
}

async function main() {
  const commit = execSync('git rev-parse HEAD').toString().trim();
  // 封存 revision 必须能解析到实际跑过的代码：dirty worktree 下 HEAD 只是
  // base——显式记录 dirty 标志，防止把未提交改动误封成已存在的 commit。
  const workingTreeDirty = execSync('git status --porcelain').toString().trim().length > 0;

  // 候选池：全部题 + 已有硬轨标定行（若有）+ owner difficulty。
  // item_calibration_question_unique 保证每题至多一条 → leftJoin 不膨胀行数。
  const rows = (await db
    .select({
      id: question.id,
      kind: question.kind,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      choices_md: question.choices_md,
      knowledge_ids: question.knowledge_ids,
      difficulty: question.difficulty,
      stored_b: item_calibration.b,
      stored_source: item_calibration.source,
    })
    .from(question)
    .leftJoin(
      item_calibration,
      and(
        eq(item_calibration.question_id, question.id),
        eq(item_calibration.track, 'hard'),
        // 只对照 feature→b 同款 provenance；fixed_anchor/manual 等其它来源不是
        // 「现行方法的库存输出」，混入会把跨方法差异误记进 vs_stored 指标。
        eq(item_calibration.source, 'llm_prior'),
      ),
    )
    .orderBy(question.id)) as SampleRow[];

  const sample = stratifiedSample(rows, SAMPLE_LIMIT);
  console.log(
    `[llasa-eval] pool=${rows.length} sample=${sample.length} reps=${REPS} ` +
      `kinds=${[...new Set(sample.map((s) => s.kind))].sort().join(',')}`,
  );
  if (DRY_RUN) {
    for (const s of sample) {
      console.log(`  ${s.kind} d=${s.difficulty} stored_b=${s.stored_b ?? '-'} ${s.id}`);
    }
    return;
  }

  const runTaskFn = makePracticeTaskRunFn(db);
  const allKnowledgeIds = [...new Set(sample.flatMap((s) => s.knowledge_ids ?? []))];
  const nameById = new Map<string, string>();
  if (allKnowledgeIds.length > 0) {
    const ks = await db
      .select({ id: knowledge.id, name: knowledge.name })
      .from(knowledge)
      .where(inArray(knowledge.id, allKnowledgeIds));
    for (const k of ks) nameById.set(k.id, k.name);
  }

  // 任务清单：question × method × rep，固定并发扇出。
  const plan: { row: SampleRow; method: Method; rep: number }[] = [];
  for (const row of sample)
    for (const method of METHODS) for (let r = 0; r < REPS; r++) plan.push({ row, method, rep: r });

  const records: CallRecord[] = [];
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < plan.length) {
      const item = plan[cursor++];
      if (!item) break;
      const kcNames = (item.row.knowledge_ids ?? [])
        .map((id) => ({ name: nameById.get(id) }))
        .filter((kc): kc is { name: string } => typeof kc.name === 'string');
      const profile = await resolveSubjectProfileForKnowledgeIds(db, item.row.knowledge_ids ?? []);
      records.push(await runOne(runTaskFn, item.row, kcNames, profile, item.method, item.rep));
      done++;
      if (done % 10 === 0) console.log(`[llasa-eval] progress ${done}/${plan.length}`);
    }
  });
  await Promise.all(workers);

  // Lane provenance 从实际 task_run 行回查，而非硬编码——provider override /
  // binding 生效时证据必须反映真实 lane。ai_task_runs.provider/model 是
  // runner 落库的运行时绑定，是本证据可拿到的最接近真相的来源。
  const runIds = records.flatMap((r) => (r.task_run_id ? [r.task_run_id] : []));
  const observedLanes =
    runIds.length > 0
      ? await db
          .selectDistinct({ provider: ai_task_runs.provider, model: ai_task_runs.model })
          .from(ai_task_runs)
          .where(inArray(ai_task_runs.id, runIds))
      : [];
  const provider =
    observedLanes.length === 1
      ? (observedLanes[0]?.provider ?? 'unknown')
      : observedLanes.length > 1
        ? `mixed:${observedLanes.map((l) => l.provider).join('+')}`
        : 'unknown';
  const model =
    observedLanes.length === 1
      ? (observedLanes[0]?.model ?? 'unknown')
      : observedLanes.length > 1
        ? `mixed:${observedLanes.map((l) => l.model).join('+')}`
        : 'unknown';

  // ── 汇总指标 ──────────────────────────────────────────────────────────
  const okBy = (m: Method) => records.filter((r) => r.method === m && r.status === 'ok');
  const perQuestion = sample.map((s) => {
    const byMethod = Object.fromEntries(
      METHODS.map((m) => [m, records.filter((r) => r.question_id === s.id && r.method === m)]),
    ) as Record<Method, CallRecord[]>;
    const bOf = (m: Method) =>
      byMethod[m].filter((r) => r.status === 'ok').map((r) => r.b_logit as number);
    return {
      question_id: s.id,
      kind: s.kind,
      difficulty: s.difficulty,
      proxy_b: difficultyToLogitB(s.difficulty),
      stored_b: s.stored_b,
      feature_bs: bOf('feature'),
      llasa_bs: bOf('llasa'),
      feature_sd: sd(bOf('feature')),
      llasa_sd: sd(bOf('llasa')),
      feature_mean: mean(bOf('feature')),
      llasa_mean: mean(bOf('llasa')),
      abs_gap: Math.abs(mean(bOf('feature')) - mean(bOf('llasa'))),
      feature_parse_fails: byMethod.feature.filter((r) => r.status !== 'ok').length,
      llasa_parse_fails: byMethod.llasa.filter((r) => r.status !== 'ok').length,
    };
  });

  const featureSds = perQuestion.map((q) => q.feature_sd).filter((x) => !Number.isNaN(x));
  const llasaSds = perQuestion.map((q) => q.llasa_sd).filter((x) => !Number.isNaN(x));
  const gaps = perQuestion
    .map((q) => q.abs_gap)
    .filter((x) => !Number.isNaN(x) && Number.isFinite(x));
  const proxyAligned = perQuestion.filter((q) => q.stored_b !== null);

  const summary = {
    commit,
    working_tree_dirty: workingTreeDirty,
    provider,
    model,
    sample_size: sample.length,
    reps: REPS,
    total_calls: records.length,
    calls_ok: records.filter((r) => r.status === 'ok').length,
    calls_parse_failed: records.filter((r) => r.status === 'parse_failed').length,
    calls_run_failed: records.filter((r) => r.status === 'run_failed').length,
    cost_usd_total: records.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
    feature: {
      ok: okBy('feature').length,
      mean_within_question_sd: mean(featureSds),
      median_within_question_sd: quantile(featureSds, 0.5),
      p90_within_question_sd: quantile(featureSds, 0.9),
      max_within_question_sd: featureSds.length > 0 ? Math.max(...featureSds) : Number.NaN,
      vs_stored_llm_prior_mean_abs_delta: mean(
        proxyAligned
          .map((q) => Math.abs(q.feature_mean - (q.stored_b as number)))
          .filter((x) => Number.isFinite(x)),
      ),
      spearman_vs_owner_difficulty: spearmanFinite(
        perQuestion.map((q) => q.feature_mean),
        perQuestion.map((q) => q.difficulty),
      ),
    },
    llasa: {
      ok: okBy('llasa').length,
      mean_within_question_sd: mean(llasaSds),
      median_within_question_sd: quantile(llasaSds, 0.5),
      p90_within_question_sd: quantile(llasaSds, 0.9),
      max_within_question_sd: llasaSds.length > 0 ? Math.max(...llasaSds) : Number.NaN,
      spearman_vs_owner_difficulty: spearmanFinite(
        perQuestion.map((q) => q.llasa_mean),
        perQuestion.map((q) => q.difficulty),
      ),
      censored_rate:
        records.filter((r) => r.method === 'llasa' && r.status === 'ok' && r.censored !== null)
          .length / Math.max(1, okBy('llasa').length),
      nonmonotone_rate:
        records.filter((r) => r.method === 'llasa' && r.status === 'ok' && r.monotone === false)
          .length / Math.max(1, okBy('llasa').length),
    },
    cross_method: {
      mean_abs_gap: mean(gaps),
      median_abs_gap: quantile(gaps, 0.5),
      p90_abs_gap: quantile(gaps, 0.9),
      spearman_feature_vs_llasa: spearmanFinite(
        perQuestion.map((q) => q.feature_mean),
        perQuestion.map((q) => q.llasa_mean),
      ),
    },
  };

  const evidence = {
    captured_at: new Date().toISOString(),
    code_revision: commit,
    working_tree_dirty: workingTreeDirty,
    ticket: 'YUK-376',
    lane: {
      provider,
      model,
      adapter: 'pi',
      tasks: ['ItemPriorTask', 'ItemPriorLlasaTask'],
    },
    summary,
    per_question: perQuestion,
    records: records.map((r) => ({
      ...r,
      // 原始输出不封存全文——digest + run id 可回查 ai_task_run；保留 cost/digest 证据。
      output_digest: r.output_digest,
    })),
    provenance:
      'all calls through runTask → PiAgentAdapter (production path); input/output sealed by sha256 digest + ai_task_run.id',
  };
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(JSON.stringify(summary, null, 2));
  console.log(`[llasa-eval] evidence sealed → ${EVIDENCE_PATH}`);
}

main().catch((err) => {
  console.error('[llasa-eval] failed', err);
  process.exit(2);
});
