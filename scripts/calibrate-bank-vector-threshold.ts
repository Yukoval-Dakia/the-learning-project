// YUK-1516 — search_bank 向量检索阈值的只读标定脚本（lead 在真实题库副本上运行）。
//
// 输入：带标签查询 JSON（模板见 scripts/fixtures/bank-vector-calibration.sample.json）：
//   { "queries": [ { "query": "…", "expected_question_ids": ["q1", …] | [], "note": "…" } ] }
//   expected_question_ids 为空数组 = 库中无该主题，规则应当不给它计入（none 方向）。
//   也接受顶层数组形式 [ {…}, … ]。带 `_template: true` 的文件会被拒绝——先填真实标签。
//
// 做什么：
//   1. 逐查询走既有 embedText（DashScope text-embedding-v4@1024，付费调用）；
//   2. 对库内全部「顶层、未撤回、带向量」的题算 cosine 距离（硬过滤基线镜像引擎
//      draft_state='all' + admission_state='any' 的默认面，无 scope 专属过滤）；
//   3. 对参数网格 {maxDistance × top1Margin} 逐点评测：present 主题的 query 级
//      precision / recall，absent 主题的 false-enough 率；
//   4. 打印现行参数（单一真相：与 bank-vector-retrieval.ts 同源常量）的结果 + 全网格 JSON。
//
// 只读边界：不写任何题库表（question / embedding / lifecycle 全程只 SELECT）。
// 唯一的写发生在 embedText 的 provider-attempt 记账（付费调用必须留痕的既有不变量，
// 与 search_bank 运行时行为一致）；嵌入结果只进内存，不落库。
//
// CLI:
//   pnpm tsx scripts/calibrate-bank-vector-threshold.ts <labelled.json> [--db-url postgres://…]
// DB URL 解析顺序：--db-url > DATABASE_URL（经 ./load-env 载入 .env）。
// 进度/预检打到 stderr，结果 JSON 打到 stdout（可管道）。

import './load-env';

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
// D3 note: unlike seed-synthetic, this script deliberately does NOT import @/db/client's
// singleton — the lead points it at an explicit bank-copy URL, so the connection is
// constructed here and closed at the end. embedText's provider-attempt receipts go through
// this same explicit handle.
import { z } from 'zod';
import {
  BANK_VECTOR_RETRIEVAL_PARAMS,
  BANK_VECTOR_RETRIEVAL_RULE_VERSION,
  type BankVectorRetrievalParams,
  bankVectorCountedRank,
} from '@/capabilities/practice/server/tools/bank-vector-retrieval';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import * as schema from '@/db/schema';
import { toSqlVector } from '@/db/vector';
import { embedText } from '@/server/ai/embed';

// ── 输入契约 ─────────────────────────────────────────────────────────────────

export const CalibrationQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(400),
    /** 该查询应当命中的题 id；[] = 主题缺位（期望 none 方向）。 */
    expected_question_ids: z.array(z.string().min(1)),
    note: z.string().optional(),
  })
  .strict();

export const CalibrationFileSchema = z.union([
  z.array(CalibrationQuerySchema),
  z
    .object({
      /** 模板标记：true ⇒ 拒绝运行（先填真实标签再删掉该字段）。 */
      _template: z.boolean().optional(),
      /** 纯说明文字，评测时忽略。 */
      _readme: z.string().optional(),
      queries: z.array(CalibrationQuerySchema).min(1),
    })
    .strict(),
]);

export interface CalibrationQuery {
  readonly query: string;
  readonly expected_question_ids: readonly string[];
  readonly note?: string;
}

export function parseCalibrationFile(raw: unknown): {
  queries: CalibrationQuery[];
  isTemplate: boolean;
} {
  const parsed = CalibrationFileSchema.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.queries;
  const isTemplate = !Array.isArray(parsed) && parsed._template === true;
  if (isTemplate) {
    throw new Error(
      'refusing to calibrate a _template file — fill in real expected_question_ids, then remove the "_template" field (see scripts/fixtures/bank-vector-calibration.sample.json)',
    );
  }
  return { queries: list, isTemplate };
}

// ── 距离采集（硬过滤基线镜像 bank-search buildFilters 的默认面）──────────────

export interface BankDistanceRow {
  readonly id: string;
  readonly prompt_preview: string | null;
  readonly distance: number;
}

/** 与引擎 draft_state='all' + admission_state='any' 相同的可见性基线：
 * 顶层、非固定窗口诊断题、无 dismissed/archived 墓碑、未撤回、带向量。 */
export async function fetchBankDistances(
  client: postgres.Sql,
  vector: readonly number[],
): Promise<BankDistanceRow[]> {
  const rows = await client<BankDistanceRow[]>`
    SELECT q.id AS id, left(q.prompt_md, 80) AS prompt_preview,
           (q.embedding <=> ${toSqlVector([...vector])}::vector) AS distance
    FROM question q
    LEFT JOIN question_group_lifecycle lc ON lc.group_id = q.id
    WHERE q.parent_question_id IS NULL
      AND q.source <> ${INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE}
      AND (q.metadata -> 'dismissed_at') IS NULL
      AND (q.metadata -> 'archived_at') IS NULL
      AND (lc.withdrawn IS NULL OR lc.withdrawn = false)
      AND q.embedding IS NOT NULL
    ORDER BY distance ASC
  `;
  return rows;
}

// ── 网格评测（纯函数；规则本体与引擎同源）────────────────────────────────────

export interface QueryRanking {
  readonly query: string;
  readonly note?: string;
  readonly expected: readonly string[];
  /** 距离升序。 */
  readonly rows: readonly BankDistanceRow[];
}

export interface GridMetrics {
  present_queries: number;
  absent_queries: number;
  /** present 且计入 id ∈ expected（正确确认主题）。 */
  counted_expected: number;
  /** present 且计入 id ∉ expected（错误确认）。 */
  counted_not_expected: number;
  /** present 且无计入（保守漏报 → none + gap）。 */
  missed_present: number;
  /** absent 且有计入（false enough 方向事件）。 */
  false_enough: number;
  /** query 级 recall：counted_expected / present_queries。 */
  query_recall: number | null;
  /** 计入时的 precision：counted_expected / (counted_expected + counted_not_expected)。 */
  precision_when_counted: number | null;
  /** absent 主题被计入的比率（计入即脱离 none；limit ≤ 计入数时会变 enough 并吞掉
   * gap_request —— 这正是要压到 0 的事件）。 */
  false_enough_rate: number | null;
}

function countedIdFor(ranking: QueryRanking, params: BankVectorRetrievalParams): string | null {
  const rank = bankVectorCountedRank(
    ranking.rows.map((row) => row.distance),
    params,
  );
  return rank === null ? null : (ranking.rows[rank]?.id ?? null);
}

export function evaluateParams(
  rankings: readonly QueryRanking[],
  params: BankVectorRetrievalParams,
): GridMetrics {
  let presentQueries = 0;
  let absentQueries = 0;
  let countedExpected = 0;
  let countedNotExpected = 0;
  let missedPresent = 0;
  let falseEnough = 0;
  for (const ranking of rankings) {
    const countedId = countedIdFor(ranking, params);
    if (ranking.expected.length === 0) {
      absentQueries++;
      if (countedId !== null) falseEnough++;
      continue;
    }
    presentQueries++;
    if (countedId === null) missedPresent++;
    else if (ranking.expected.includes(countedId)) countedExpected++;
    else countedNotExpected++;
  }
  const countedPresent = countedExpected + countedNotExpected;
  return {
    present_queries: presentQueries,
    absent_queries: absentQueries,
    counted_expected: countedExpected,
    counted_not_expected: countedNotExpected,
    missed_present: missedPresent,
    false_enough: falseEnough,
    query_recall: presentQueries > 0 ? countedExpected / presentQueries : null,
    precision_when_counted: countedPresent > 0 ? countedExpected / countedPresent : null,
    false_enough_rate: absentQueries > 0 ? falseEnough / absentQueries : null,
  };
}

export interface CalibrationReport {
  rule_version: number;
  chosen: {
    params: BankVectorRetrievalParams;
    metrics: GridMetrics;
    per_query: Array<{
      query: string;
      note?: string;
      expected_count: number;
      counted_id: string | null;
      counted_in_expected: boolean;
      top3: Array<{
        id: string;
        distance: number;
        prompt_preview: string | null;
        in_expected: boolean;
      }>;
    }>;
  };
  grid: Array<{ params: BankVectorRetrievalParams; metrics: GridMetrics }>;
}

export function buildReport(
  rankings: readonly QueryRanking[],
  grid: readonly BankVectorRetrievalParams[],
  chosen: BankVectorRetrievalParams = BANK_VECTOR_RETRIEVAL_PARAMS,
): CalibrationReport {
  return {
    rule_version: BANK_VECTOR_RETRIEVAL_RULE_VERSION,
    chosen: {
      params: chosen,
      metrics: evaluateParams(rankings, chosen),
      per_query: rankings.map((ranking) => {
        const countedId = countedIdFor(ranking, chosen);
        return {
          query: ranking.query,
          ...(ranking.note !== undefined ? { note: ranking.note } : {}),
          expected_count: ranking.expected.length,
          counted_id: countedId,
          counted_in_expected: countedId !== null && ranking.expected.includes(countedId),
          top3: ranking.rows.slice(0, 3).map((row) => ({
            id: row.id,
            distance: row.distance,
            prompt_preview: row.prompt_preview,
            in_expected: ranking.expected.includes(row.id),
          })),
        };
      }),
    },
    grid: grid.map((params) => ({ params, metrics: evaluateParams(rankings, params) })),
  };
}

/** 默认网格：围绕实测锚点（正确目标 margin 0.253 / 无关命中 margin 0.110）扫两侧。 */
export const DEFAULT_GRID: readonly BankVectorRetrievalParams[] = [
  0.45, 0.5, 0.55, 0.6, 0.65,
].flatMap((maxDistance) =>
  [0.05, 0.08, 0.1, 0.12, 0.15, 0.18, 0.2, 0.25, 0.3].map((top1Margin) => ({
    maxDistance,
    top1Margin,
  })),
);

// ── CLI ─────────────────────────────────────────────────────────────────────

function maskUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbUrlFlag = args.indexOf('--db-url');
  const dbUrl =
    dbUrlFlag !== -1 && args[dbUrlFlag + 1] !== undefined
      ? args[dbUrlFlag + 1]
      : process.env.DATABASE_URL;
  const positional = args.filter(
    (arg, i) => arg !== '--db-url' && !(dbUrlFlag !== -1 && i === dbUrlFlag + 1),
  );
  if (positional.length !== 1 || dbUrl === undefined || dbUrl.length === 0) {
    console.error(
      'usage: pnpm tsx scripts/calibrate-bank-vector-threshold.ts <labelled.json> [--db-url postgres://…]',
    );
    process.exit(2);
  }

  const { queries } = parseCalibrationFile(JSON.parse(readFileSync(positional[0], 'utf8')));
  const masked = maskUrl(dbUrl);
  const client = postgres(dbUrl, { max: 2 });
  try {
    const bankRows = await client<{ total: number; with_vectors: number }[]>`
      SELECT count(*) FILTER (WHERE q.parent_question_id IS NULL) AS total,
             count(*) FILTER (WHERE q.parent_question_id IS NULL AND q.embedding IS NOT NULL) AS with_vectors
      FROM question q
    `;
    const bank = bankRows[0];
    console.error(`[calibrate] db=${masked}`);
    console.error(
      `[calibrate] bank: top-level=${bank.total} with-vectors=${bank.with_vectors}; queries=${queries.length} (each = 1 paid embed via embedText)`,
    );
    if (bank.with_vectors === 0) {
      throw new Error('no question carries an embedding — nothing to calibrate');
    }

    // Provider-attempt 记账走同一显式连接（付费留痕；除此以外零写入）。
    const db = drizzle(client, { schema }) as unknown as Db;
    const embedCache = new Map<string, number[]>();
    const rankings: QueryRanking[] = [];
    for (const entry of queries) {
      let vector = embedCache.get(entry.query);
      if (vector === undefined) {
        vector = await embedText(entry.query, {
          db,
          caller: 'api',
          deadlineAt: new Date(Date.now() + 20_000),
        });
        embedCache.set(entry.query, vector);
      }
      const rows = await fetchBankDistances(client, vector);
      rankings.push({
        query: entry.query,
        ...(entry.note !== undefined ? { note: entry.note } : {}),
        expected: entry.expected_question_ids,
        rows,
      });
      console.error(
        `[calibrate] "${entry.query}" → nearest ${rows[0]?.distance.toFixed(4) ?? 'n/a'} (${rows[0]?.id ?? '-'}) / second ${rows[1]?.distance.toFixed(4) ?? 'n/a'}`,
      );
    }
    const report = buildReport(rankings, DEFAULT_GRID);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end();
  }
}

const isEntry =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('[calibrate] failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
