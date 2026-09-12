/**
 * jyeoo:backfill — 手动触发 jyeoo 供题批量入库（YUK-986 / Supply-Agent E1 的最小生产 caller）。
 *
 * 确定性两步：jyeoo_fetch_candidates（grade 路线抓自包含候选）→ 逐候选做
 * knowledge_hints 确定性名匹配 → store_sourced_question（dedup / live-KC / verify 链
 * 权威判定）。没有 agent——E2/E3 的 agent 层落地前让供题线可手动复工；agent 之后接管
 * 的是「决策」（抓什么、挂哪、提交哪些），工具与 commit seam 原样复用。
 *
 * Usage:
 *   pnpm jyeoo:backfill                            # grade 11 math2，pages 2 papers 2 max 10
 *   pnpm jyeoo:backfill --grade 12 --max 20        # 高三、本次拉 20
 *   pnpm jyeoo:backfill --dry-run                  # 只抓候选，不入库
 *   pnpm jyeoo:backfill --no-root-fallback         # hint 全未命中的题丢弃（默认挂科目根+coarse）
 *
 * 预算：producer 谨慎档 40 题/日硬闸；loom 侧事件溯源日租约 pre-flight（JYEOO_DAILY_FETCH_BUDGET
 * 可调低）。账号：jyeoo-rs 默认 ~/.config/jyeoo-rs/api-account.json（JYEOO_RS_BINARY 指二进制）。
 */
import { createId } from '@paralleldrive/cuid2';
import { config } from 'dotenv';

config({ path: '.env', override: false });

import {
  findSubjectRootKnowledgeId,
  jyeooFetchCandidatesTool,
  matchJyeooKnowledgeHints,
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
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx: ToolContext = {
    db,
    taskRunId: `manual_jyeoo_backfill_${createId()}`,
    callerActor: { kind: 'user', ref: 'operator:jyeoo_backfill' },
  };

  console.log(
    `[jyeoo:backfill] fetch: grade=${args.grade} subject=${args.subject} pages=${args.pages} papers=${args.papers} max=${args.max}${args.dryRun ? ' (dry-run)' : ''}`,
  );
  const fetched = await jyeooFetchCandidatesTool.execute(ctx, {
    grade: args.grade,
    subject: args.subject,
    pages: args.pages,
    max_papers: args.papers,
    session_max: args.max,
    ...(args.kind ? { kind: args.kind } : {}),
    ...(args.band ? { difficulty_band: args.band } : {}),
  });

  if (fetched.status === 'budget_exhausted') {
    console.log(`[jyeoo:backfill] 当日预算已尽（日 ${fetched.budget.daily_budget}），未发起抓取。`);
    return;
  }
  if (fetched.status === 'failed') {
    console.error(
      `[jyeoo:backfill] 抓取失败: ${fetched.failure_class}${fetched.retryable ? '（可重试）' : ''} — ${fetched.detail}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `[jyeoo:backfill] 候选 ${fetched.counts.candidates}（抓 ${fetched.counts.fetched} / 校验 ${fetched.counts.validated} / 丢弃 ${fetched.dropped.length}）· 预算余 ${fetched.budget.remaining_after}`,
  );
  if (args.dryRun) {
    for (const candidate of fetched.candidates) {
      console.log(
        `  [dry-run] ${candidate.source_id ?? candidate.candidate_id} · hints=[${candidate.knowledge_hints.join(' | ')}] · ${candidate.question.prompt_md.slice(0, 60)}…`,
      );
    }
    return;
  }

  const funnel = { inserted: 0, rejected: 0, skipped: 0, byReason: {} as Record<string, number> };
  for (const candidate of fetched.candidates) {
    const match = await matchJyeooKnowledgeHints(db, args.domain, candidate.knowledge_hints);
    let knowledgeIds = match.matched.map((hit) => hit.knowledgeId);
    let attributionState: 'matched' | 'coarse' = 'matched';
    if (knowledgeIds.length === 0) {
      if (!args.rootFallback) {
        funnel.skipped += 1;
        console.log(
          `  [skip] hints 全未命中且 --no-root-fallback: [${candidate.knowledge_hints.join(' | ')}]`,
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
      candidate: {
        candidate_id: candidate.candidate_id,
        question: candidate.question,
        extraction_hash: candidate.extraction_hash,
        knowledge_hints: candidate.knowledge_hints,
        source_id: candidate.source_id,
        figures: candidate.figures,
        image_refs: candidate.image_refs,
        structured: candidate.structured,
        staged_asset_ids: candidate.staged_asset_ids,
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
