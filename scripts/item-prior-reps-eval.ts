// scripts/item-prior-reps-eval.ts
/**
 * YUK-1034 — feature→b 重复采样 median 聚合的 actual-output 复测。
 *
 * 目的：验证「同法 N 次采样取 b_logit median」对 within-question 离散度的压制
 * 效果（YUK-376 eval 的建议②，median-of-3 期望把有效 SD 从 ~0.28 压到 ~0.17）。
 *
 * 设计：与 llasa-prior-eval 同款分层抽样（全题池按 kind 分层，ORDER BY id）。
 * 每题跑 GROUPS 组 × REPS 次 ItemPriorTask（feature 路径，生产同款
 * runTask → PiAgentAdapter）；每组内用 job 同款聚合函数
 * aggregateItemPriorRepDrafts（src/core/item-prior-reps.ts）取 median。比较：
 *   1. reps=1 估计量噪声：每题全部 GROUPS×REPS 个单次样本的 within-question
 *      SD（与 YUK-376 sealed 0.298/0.276 同口径，n=9 比 n=3 估计更稳）；
 *   2. reps=R 估计量噪声：每题 GROUPS 个组内 median 的 within-question SD——
 *      即「median-of-R」这个估计量本身的实测离散度。
 *
 * 读侧：只读 question / item_calibration / knowledge / ai_task_runs；写侧只有
 * runner 自身的 ai_task_run 留痕（生产同款）。不碰 item_calibration 写路径。
 *
 * Run:
 *   pnpm tsx scripts/item-prior-reps-eval.ts                          # 全真跑（默认 30 题 ×3 组 ×3 reps = 270 calls）
 *   PRIOR_REPS_EVAL_LIMIT=6 PRIOR_REPS_EVAL_GROUPS=2 pnpm tsx …       # 缩小 sweep
 *   pnpm tsx scripts/item-prior-reps-eval.ts --dry-run                # 只列样本不发请求
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
const { parseItemPriorOutput } = await import('@/server/ai/item-prior');
const { aggregateItemPriorRepDrafts } = await import('@/core/item-prior-reps');
const { makePracticeTaskRunFn } = await import('@/capabilities/practice/server/task-runtime');

const DRY_RUN = process.argv.includes('--dry-run');
const SAMPLE_LIMIT = Number(process.env.PRIOR_REPS_EVAL_LIMIT ?? 30);
const REPS = Number(process.env.PRIOR_REPS_EVAL_REPS ?? 3); // 组内采样数（= job 的 reps 参数）
const GROUPS = Number(process.env.PRIOR_REPS_EVAL_GROUPS ?? 3); // 独立 median-of-REPS 组数（估估计量 SD）
const CONCURRENCY = Number(process.env.PRIOR_REPS_EVAL_CONCURRENCY ?? 4);
const EVIDENCE_PATH = join(
  process.cwd(),
  'docs/planning/evidence/2026-09-24-item-prior-reps-eval-actual.json',
);

interface SampleRow {
  id: string;
  kind: string;
  prompt_md: string;
  knowledge_ids: string[];
  difficulty: number;
  stored_b: number | null;
  stored_source: string | null;
}

interface CallRecord {
  question_id: string;
  group: number;
  rep: number;
  status: 'ok' | 'parse_failed' | 'run_failed';
  b_logit?: number;
  confidence?: number;
  task_run_id?: string;
  cost_usd?: number;
  cost_basis?: string;
  input_digest: string;
  output_digest?: string;
  error?: string;
}

const sha256 = (text: string) =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

/** 分层抽样：按 kind 比例分配，每 kind 至少 1 道（有料的才计入），ORDER BY id 定序。
 * 与 llasa-prior-eval 同法——题池不变时复现同一批样本。 */
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
  group: number,
  rep: number,
): Promise<CallRecord> {
  // 与 job feature 路径逐字节同款输入（prompt_md/kind/knowledge_context）。
  const input = { prompt_md: row.prompt_md, kind: row.kind, knowledge_context: kcNames };
  const inputDigest = sha256(`feature:${JSON.stringify(input)}`);
  const base = { question_id: row.id, group, rep, input_digest: inputDigest };
  try {
    const result = await runTaskFn('ItemPriorTask', input, { subjectProfile });
    const common = {
      ...base,
      task_run_id: result.task_run_id,
      cost_usd: result.cost_usd,
      cost_basis: result.cost_basis,
      output_digest: sha256(result.text),
    };
    try {
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
    `[reps-eval] pool=${rows.length} sample=${sample.length} groups=${GROUPS} reps=${REPS} ` +
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

  // 任务清单：question × group × rep，固定并发扇出。rep 间无差别（同输入重复
  // 采样），group 只是「这 R 个 rep 折成一个 median」的分组标签。
  const plan: { row: SampleRow; group: number; rep: number }[] = [];
  for (const row of sample)
    for (let g = 0; g < GROUPS; g++)
      for (let r = 0; r < REPS; r++) plan.push({ row, group: g, rep: r });

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
      records.push(await runOne(runTaskFn, item.row, kcNames, profile, item.group, item.rep));
      done++;
      if (done % 10 === 0) console.log(`[reps-eval] progress ${done}/${plan.length}`);
    }
  });
  await Promise.all(workers);

  // Lane provenance 从实际 task_run 行回查，而非硬编码——provider override /
  // binding 生效时证据必须反映真实 lane。
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

  // ── 汇总：每题两组估计量 ────────────────────────────────────────────────
  // single_*：全部 ok rep 的 b_logit（reps=1 估计量噪声，同 376 口径）；
  // median_*：每组内 ok draft 经 job 同款 aggregateItemPriorRepDrafts 折成
  // 一个 median b（reps=R 估计量噪声）。组内全败 → 该组无 median。
  const perQuestion = sample.map((s) => {
    const recs = records.filter((r) => r.question_id === s.id);
    const singleBs = recs.filter((r) => r.status === 'ok').map((r) => r.b_logit as number);
    const groupMedians: number[] = [];
    let groupsAllFailed = 0;
    for (let g = 0; g < GROUPS; g++) {
      const groupDrafts = recs
        .filter((r) => r.group === g && r.status === 'ok')
        .map((r) => ({
          b_logit: r.b_logit as number,
          confidence: r.confidence as number,
          reasoning: 'eval-sealed', // 原文不封存；median 选择只看数值字段
        }));
      if (groupDrafts.length === 0) {
        groupsAllFailed++;
        continue;
      }
      groupMedians.push(aggregateItemPriorRepDrafts(groupDrafts, REPS).draft.b_logit);
    }
    return {
      question_id: s.id,
      kind: s.kind,
      difficulty: s.difficulty,
      proxy_b: difficultyToLogitB(s.difficulty),
      stored_b: s.stored_b,
      single_bs: singleBs,
      median_bs: groupMedians,
      single_sd: sd(singleBs),
      median_sd: sd(groupMedians),
      single_mean: mean(singleBs),
      median_mean: mean(groupMedians),
      n_ok: singleBs.length,
      n_failed: recs.filter((r) => r.status !== 'ok').length,
      groups_all_failed: groupsAllFailed,
    };
  });

  const singleSds = perQuestion.map((q) => q.single_sd).filter((x) => !Number.isNaN(x));
  const medianSds = perQuestion.map((q) => q.median_sd).filter((x) => !Number.isNaN(x));
  const paired = perQuestion.filter(
    (q) => !Number.isNaN(q.single_sd) && !Number.isNaN(q.median_sd),
  );
  const proxyAligned = perQuestion.filter((q) => q.stored_b !== null);

  const summary = {
    commit,
    working_tree_dirty: workingTreeDirty,
    provider,
    model,
    sample_size: sample.length,
    groups: GROUPS,
    reps_per_group: REPS,
    total_calls: records.length,
    calls_ok: records.filter((r) => r.status === 'ok').length,
    calls_parse_failed: records.filter((r) => r.status === 'parse_failed').length,
    calls_run_failed: records.filter((r) => r.status === 'run_failed').length,
    cost_usd_total: records.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
    reps1_single_sample: {
      n_questions_with_sd: singleSds.length,
      mean_within_question_sd: mean(singleSds),
      median_within_question_sd: quantile(singleSds, 0.5),
      p90_within_question_sd: quantile(singleSds, 0.9),
      max_within_question_sd: singleSds.length > 0 ? Math.max(...singleSds) : Number.NaN,
      vs_stored_llm_prior_mean_abs_delta: mean(
        proxyAligned
          .map((q) => Math.abs(q.single_mean - (q.stored_b as number)))
          .filter((x) => Number.isFinite(x)),
      ),
      spearman_vs_owner_difficulty: spearmanFinite(
        perQuestion.map((q) => q.single_mean),
        perQuestion.map((q) => q.difficulty),
      ),
    },
    repsN_median_of_reps: {
      n_questions_with_sd: medianSds.length,
      mean_within_question_sd: mean(medianSds),
      median_within_question_sd: quantile(medianSds, 0.5),
      p90_within_question_sd: quantile(medianSds, 0.9),
      max_within_question_sd: medianSds.length > 0 ? Math.max(...medianSds) : Number.NaN,
      spearman_vs_owner_difficulty: spearmanFinite(
        perQuestion.map((q) => q.median_mean),
        perQuestion.map((q) => q.difficulty),
      ),
    },
    // 配对对比：只在两种 SD 都可估的题上算 reduction，避免幸存者偏差。
    paired_reduction: {
      n_questions: paired.length,
      mean_sd_ratio_median_over_single: mean(
        paired.map((q) => q.median_sd / Math.max(q.single_sd, 1e-9)),
      ),
      mean_abs_sd_drop: mean(paired.map((q) => q.single_sd - q.median_sd)),
    },
  };

  const evidence = {
    captured_at: new Date().toISOString(),
    code_revision: commit,
    working_tree_dirty: workingTreeDirty,
    ticket: 'YUK-1034',
    lane: {
      provider,
      model,
      adapter: 'pi',
      tasks: ['ItemPriorTask'],
      aggregation: `median-of-${REPS} via src/core/item-prior-reps.ts aggregateItemPriorRepDrafts`,
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
  console.log(`[reps-eval] evidence sealed → ${EVIDENCE_PATH}`);
}

main().catch((err) => {
  console.error('[reps-eval] failed', err);
  process.exit(2);
});
