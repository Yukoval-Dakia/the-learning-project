// companion view（B1 唯一落地 view）：三段装配 + 按优先级裁剪到 ≤1000 估计 token。
// 渲染序即文档序；裁剪序：Steering > Δ > 掌握和错因 > 稳态画像 > 信号 > 昨夜。

import type { Db, Tx } from '@/db/client';
import type { LearnerContextResult } from '@/kernel/read-models/learner-context';
import { trimUnitsToBudget } from './budget';
import { readContractSection } from './contract';
import { readDeltaSection, shanghaiLabel } from './delta';
import { readSteadySection } from './steady';
import type { DeltaSection } from './types';

type DbLike = Db | Tx;

const FAILURE_STREAK_HEADER_MIN = 3;

function renderDelta(delta: DeltaSection): string {
  const lines: string[] = [];
  const c = delta.counts;
  const parts = [
    c.answers > 0 ? `新作答 ${c.answers} 次` : '',
    c.reviews > 0 ? `复习 ${c.reviews} 次` : '',
    c.captures > 0 ? `录入 ${c.captures} 条` : '',
    c.decisions > 0 ? `提议决策 ${c.decisions} 条` : '',
    c.steering > 0 ? `目标调整 ${c.steering} 次` : '',
    c.messages > 0 ? `发言 ${c.messages} 次` : '',
  ].filter((p) => p.length > 0);
  const scope = delta.asOf ? `自 ${shanghaiLabel(delta.asOf)} 固化以来` : '近期';
  lines.push(parts.length > 0 ? `${scope}：${parts.join('，')}` : `${scope}暂无新学习动态`);
  for (const line of delta.recent) lines.push(`· ${shanghaiLabel(line.at)} ${line.label}`);
  const tail = [`今日待复习 ${delta.reviewDueCount} 项`];
  if (delta.failureStreak && delta.failureStreak.count >= FAILURE_STREAK_HEADER_MIN) {
    tail.push(`连续答错：${delta.failureStreak.knowledge_name}（${delta.failureStreak.count} 次）`);
  }
  if (delta.lastActivityAt) tail.push(`最近活动 ${shanghaiLabel(delta.lastActivityAt)}`);
  lines.push(tail.join('；'));
  return lines.join('\n');
}

/**
 * The companion startup segment: three sections read from existing read models,
 * rendered then deterministically trimmed to the view budget.
 */
export async function assembleCompanionContext(
  db: DbLike,
  opts: { now: Date },
): Promise<LearnerContextResult> {
  const steady = await readSteadySection(db);
  const [delta, contract] = await Promise.all([
    readDeltaSection(db, { asOf: steady.asOf, now: opts.now }),
    readContractSection(db, { now: opts.now }),
  ]);

  const masteryMd = [contract.masteryMd, contract.causesMd].filter(Boolean).join('\n') || null;
  const portraitMd = steady.portraitMd ? `画像：${steady.portraitMd}` : null;
  const signalsMd =
    contract.signalsMd.length > 0 ? `判读备注：${contract.signalsMd.join('')}` : null;
  const overnightMd = contract.overnightMd ? `昨夜交班：${contract.overnightMd}` : null;

  const trimmed = trimUnitsToBudget([
    { rank: 0, markdown: contract.steeringMd },
    { rank: 1, markdown: renderDelta(delta) },
    { rank: 2, markdown: masteryMd },
    { rank: 3, markdown: portraitMd },
    { rank: 4, markdown: signalsMd },
    { rank: 5, markdown: overnightMd },
  ]);

  return {
    view: 'companion',
    markdown: trimmed.markdown,
    estimatedTokens: trimmed.estimatedTokens,
    asOf: steady.asOf ? steady.asOf.toISOString() : null,
  };
}
