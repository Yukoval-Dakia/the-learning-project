/**
 * jyeoo:backfill — 手动触发 jyeoo 供题批量入库（YUK-986 / Supply-Agent E1 的最小生产 caller）。
 *
 * 确定性两步：runJyeooFetchCandidates（jyeoo_fetch_candidates 工具的 fetch 核，
 * grade 路线抓自包含候选）→ 逐候选做 knowledge_hints 确定性名匹配 →
 * store_sourced_question（dedup / live-KC / verify 链权威判定）。没有 agent——E2/E3
 * 的 agent 层落地前让供题线可手动复工；agent 之后接管的是「决策」（抓什么、挂哪、
 * 提交哪些），fetch 核与 commit seam 原样复用。
 *
 * Usage:
 *   pnpm jyeoo:backfill                            # grade 11 math2，pages 2 papers 2 max 10
 *   pnpm jyeoo:backfill --grade 12 --max 20        # 高三、本次拉 20
 *   pnpm jyeoo:backfill --timeout-ms 1800000       # 等价 JYEOO_BACKFILL_TIMEOUT_MS 直给
 *   pnpm jyeoo:backfill --dry-run                  # 只抓候选，不入库
 *   pnpm jyeoo:backfill --no-root-fallback         # hint 全未命中的题丢弃（默认挂科目根+coarse）
 *
 * 预算：producer 谨慎档 40 题/日硬闸；loom 侧事件溯源日租约 pre-flight（JYEOO_DAILY_FETCH_BUDGET
 * 可调低）。账号：jyeoo-rs 默认 ~/.config/jyeoo-rs/api-account.json（JYEOO_RS_BINARY 指二进制）。
 *
 * Spawn 超时（YUK-998）：本脚本是批量 caller，不吃 in-band 的 JYEOO_SPAWN_TIMEOUT_MS
 * 120s 默认——grade 路线 ~45s+/题串行，120s 会在内容拉取中途 SIGKILL 丢整批、白烧
 * producer 侧已产生的付费拉题。解析优先级：JYEOO_BACKFILL_TIMEOUT_MS（专属覆盖）→
 * JYEOO_SPAWN_TIMEOUT_MS（共享边界，显式设置时同效）→ 默认 --max N × 90s（N=10 ⇒
 * 900s，YUK-989 复验实证档）。手动给值建议 ≥ 本批 session_max × 90s；显式给小了会
 * warn 但不拦（可能是故意的短 smoke）。非数字/非正值 → NaN → spawn fail-closed。
 */
import { createId } from '@paralleldrive/cuid2';
import { config } from 'dotenv';

config({ path: '.env', override: false });

import {
  JYEOO_BACKFILL_PER_QUESTION_MS,
  findSubjectRootKnowledgeId,
  jyeooBackfillSpawnTimeoutMs,
  matchJyeooKnowledgeHints,
  runJyeooFetchCandidates,
  storeSourcedQuestionTool,
} from '@/capabilities/practice/public';
import { db } from '@/db/client';
import type { ToolContext } from '@/kernel/tools/types';

interface CliArgs {
  grade: 10 | 11 | 12;
  subject: string;
  pages: number;
  papers: number;
  max: number;
  domain: string;
  subjectId: string;
  kind?: string;
  band?: 'below' | 'near' | 'above' | 'stretch';
  /** 等价 JYEOO_BACKFILL_TIMEOUT_MS 的 CLI 直给（优先于一切 env）。 */
  timeoutMs?: number;
  dryRun: boolean;
  rootFallback: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    grade: 11,
    subject: 'math2',
    pages: 2,
    papers: 2,
    max: 10,
    domain: 'math',
    subjectId: 'math',
    dryRun: false,
    rootFallback: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} 缺参数值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--grade': {
        const g = Number.parseInt(next(), 10);
        if (g !== 10 && g !== 11 && g !== 12) throw new Error('--grade 仅支持 10/11/12');
        args.grade = g;
        break;
      }
      case '--subject':
        args.subject = next();
        break;
      case '--pages':
        args.pages = Number.parseInt(next(), 10);
        break;
      case '--papers':
        args.papers = Number.parseInt(next(), 10);
        break;
      case '--max':
        args.max = Number.parseInt(next(), 10);
        break;
      case '--timeout-ms': {
        // 等价于 JYEOO_BACKFILL_TIMEOUT_MS（ CLI 直给优先——写入该 env 让
        // jyeooBackfillSpawnTimeoutMs 的单一口径解析生效 ）。
        args.timeoutMs = Number.parseInt(next(), 10);
        break;
      }
      case '--domain':
        args.domain = next();
        break;
      case '--subject-id':
        args.subjectId = next();
        break;
      case '--kind':
        args.kind = next();
        break;
      case '--band': {
        const band = next();
        if (!['below', 'near', 'above', 'stretch'].includes(band)) {
          throw new Error('--band 仅支持 below/near/above/stretch');
        }
        args.band = band as CliArgs['band'];
        break;
      }
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--no-root-fallback':
        args.rootFallback = false;
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }
  // 原工具层 zod 边界的等价护栏（脚本直调 fetch 核后不再经过 inputSchema）。
  if (!Number.isInteger(args.pages) || args.pages < 1 || args.pages > 10) {
    throw new Error('--pages 仅支持 1-10');
  }
  if (!Number.isInteger(args.papers) || args.papers < 1 || args.papers > 20) {
    throw new Error('--papers 仅支持 1-20');
  }
  if (!Number.isInteger(args.max) || args.max < 1 || args.max > 40) {
    throw new Error('--max 仅支持 1-40（producer 日预算谨慎档）');
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx: ToolContext = {
    db,
    taskRunId: `manual_jyeoo_backfill_${createId()}`,
    callerActor: { kind: 'user', ref: 'operator:jyeoo_backfill' },
  };

  // 批量 caller 的 spawn 超时（YUK-998）：--timeout-ms 直给 > JYEOO_BACKFILL_TIMEOUT_MS
  // > JYEOO_SPAWN_TIMEOUT_MS > 默认 --max × 90s。非法值 fail-fast（不 spawn、不烧预算）；
  // 显式给小了 warn 不拦（可能是短 smoke）。
  const spawnTimeoutMs = args.timeoutMs ?? jyeooBackfillSpawnTimeoutMs(args.max);
  if (!Number.isFinite(spawnTimeoutMs) || spawnTimeoutMs <= 0) {
    console.error(
      `[jyeoo:backfill] spawn 超时配置非法（${spawnTimeoutMs}）——检查 --timeout-ms / ` +
        `JYEOO_BACKFILL_TIMEOUT_MS / JYEOO_SPAWN_TIMEOUT_MS 的正整数毫秒值`,
    );
    process.exitCode = 1;
    return;
  }
  const estimatedMs = args.max * JYEOO_BACKFILL_PER_QUESTION_MS;
  if (spawnTimeoutMs < estimatedMs) {
    console.warn(
      `[jyeoo:backfill] spawn 超时 ${spawnTimeoutMs}ms 低于本批估算 ${estimatedMs}ms（--max ${args.max} × 90s）；` +
        `中途 SIGKILL 会丢整批并白烧已产生的付费拉题——调大 JYEOO_BACKFILL_TIMEOUT_MS 或 --timeout-ms`,
    );
  }
  console.log(
    `[jyeoo:backfill] fetch: grade=${args.grade} subject=${args.subject} pages=${args.pages} papers=${args.papers} max=${args.max} timeout=${spawnTimeoutMs}ms${args.dryRun ? ' (dry-run)' : ''}`,
  );
  const fetched = await runJyeooFetchCandidates({
    db,
    input: {
      grade: args.grade,
      subject: args.subject,
      pages: args.pages,
      maxPapers: args.papers,
      sessionMax: args.max,
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.band ? { difficultyBand: args.band } : {}),
    },
    spawnTimeoutMs,
    ctx: { taskRunId: ctx.taskRunId },
  });

  if (fetched.status === 'budget_exhausted') {
    console.log(`[jyeoo:backfill] 当日预算已尽（日 ${fetched.budget.dailyBudget}），未发起抓取。`);
    return;
  }
  if (fetched.status === 'failed') {
    console.error(
      `[jyeoo:backfill] 抓取失败: ${fetched.failureClass}${fetched.retryable ? '（可重试）' : ''} — ${fetched.detail}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `[jyeoo:backfill] 候选 ${fetched.counts.candidates}（抓 ${fetched.counts.fetched} / 校验 ${fetched.counts.validated} / 丢弃 ${fetched.dropped.length}）· 预算余 ${fetched.budget.remainingAfter}`,
  );
  if (args.dryRun) {
    for (const candidate of fetched.candidates) {
      console.log(
        `  [dry-run] ${candidate.sourceId ?? candidate.candidateId} · hints=[${candidate.knowledgeHints.join(' | ')}] · ${candidate.question.prompt_md.slice(0, 60)}…`,
      );
    }
    return;
  }

  const funnel = { inserted: 0, rejected: 0, skipped: 0, byReason: {} as Record<string, number> };
  for (const candidate of fetched.candidates) {
    const match = await matchJyeooKnowledgeHints(db, args.domain, candidate.knowledgeHints);
    let knowledgeIds = match.matched.map((hit) => hit.knowledgeId);
    let attributionState: 'matched' | 'coarse' = 'matched';
    if (knowledgeIds.length === 0) {
      if (!args.rootFallback) {
        funnel.skipped += 1;
        console.log(
          `  [skip] hints 全未命中且 --no-root-fallback: [${candidate.knowledgeHints.join(' | ')}]`,
        );
        continue;
      }
      const rootId = await findSubjectRootKnowledgeId(db, args.domain);
      if (!rootId) {
        console.error(`  [skip] 科目根节点缺失（domain=${args.domain}）——不得静默挂错科目`);
        funnel.skipped += 1;
        continue;
      }
      knowledgeIds = [rootId];
      attributionState = 'coarse';
    }

    const stored = await storeSourcedQuestionTool.execute(ctx, {
      source_route: 'jyeoo_fetch',
      candidate: {
        candidate_id: candidate.candidateId,
        question: candidate.question,
        extraction_hash: candidate.extractionHash,
        knowledge_hints: candidate.knowledgeHints,
        source_id: candidate.sourceId,
        figures: candidate.figures,
        image_refs: candidate.imageRefs,
        structured: candidate.structured,
        staged_asset_ids: candidate.stagedAssetIds,
      },
      knowledge_ids: knowledgeIds,
      attribution_state: attributionState,
      subject_id: args.subjectId,
    });
    if (stored.status === 'inserted') {
      funnel.inserted += 1;
      console.log(
        `  [inserted] ${stored.question_id} · ${attributionState} · KC=${knowledgeIds.length} · verify=${stored.verify_enqueued ? 'ok' : 'pending'}`,
      );
    } else {
      funnel.rejected += 1;
      funnel.byReason[stored.reason] = (funnel.byReason[stored.reason] ?? 0) + 1;
      console.log(`  [rejected:${stored.reason}] ${stored.detail}`);
    }
  }
  console.log(`[jyeoo:backfill] 完成: ${JSON.stringify(funnel)}`);
}

await main();
