// companion view（B1 唯一落地 view）：三段装配 + 按优先级裁剪到 ≤1000 估计 token。
// 渲染序即文档序；裁剪序：Steering > Δ > 掌握和错因 > 稳态画像 > 信号 > 昨夜，
// 到期题明细与失败明细（§13 给「怎么和我说话」留空间）最先被裁。

import type { Db, Tx } from '@/db/client';
import type { LearnerContextResult } from '@/kernel/read-models/learner-context';
import { trimUnitsToBudget } from './budget';
import { readContractSection } from './contract';
import { readDeltaSection, shanghaiLabel } from './delta';
import { DELTA_FALLBACK_LOOKBACK_MS, readSteadySection } from './steady';
import type { DeltaSection, DueItemLine } from './types';

type DbLike = Db | Tx;

const FAILURE_STREAK_HEADER_MIN = 3;

const LOOKBACK_DAYS = Math.round(DELTA_FALLBACK_LOOKBACK_MS / (24 * 60 * 60 * 1000));

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
  const scope =
    delta.asOfBasis === 'dreaming'
      ? `自 ${shanghaiLabel(delta.asOf)} 固化以来`
      : `近 ${LOOKBACK_DAYS} 天`;
  lines.push(parts.length > 0 ? `${scope}：${parts.join('，')}` : `${scope}暂无新学习动态`);
  for (const line of delta.recent) lines.push(`· ${shanghaiLabel(line.at)} ${line.label}`);
  const tail = [
    `今日待复习 ${delta.reviewDueOverCap ? `${delta.reviewDueCount}+` : delta.reviewDueCount} 项`,
  ];
  if (delta.failureStreak && delta.failureStreak.count >= FAILURE_STREAK_HEADER_MIN) {
    tail.push(`连续答错：${delta.failureStreak.knowledge_name}（${delta.failureStreak.count} 次）`);
  }
  if (delta.lastActivityAt) tail.push(`最近活动 ${shanghaiLabel(delta.lastActivityAt)}`);
  lines.push(tail.join('；'));
  return lines.join('\n');
}

function renderDueItems(items: DueItemLine[]): string | null {
  if (items.length === 0) return null;
  return items
    .map((item) => {
      const kcs = item.knowledgeNames.length > 0 ? `（${item.knowledgeNames.join('、')}）` : '';
      return `· ${item.stem}${kcs}`;
    })
    .join('\n');
}

/**
 * The companion startup segment: three sections read from existing read models,
 * rendered then deterministically trimmed to the view budget. The three reads
 * are independent (not one snapshot); the segment is an advisory attention
 * prior, so mild read skew is acceptable.
 */
export async function assembleCompanionContext(
  db: DbLike,
  opts: { now: Date; budget?: number },
): Promise<LearnerContextResult> {
  const steady = await readSteadySection(db, { now: opts.now });
  const [delta, contract] = await Promise.all([
    readDeltaSection(db, { asOf: steady.asOf, asOfBasis: steady.asOfBasis, now: opts.now }),
    readContractSection(db, { now: opts.now }),
  ]);

  const masteryMd = [contract.masteryMd, contract.causesMd].filter(Boolean).join('\n') || null;
  const portraitMd = steady.portraitMd ? `画像：${steady.portraitMd}` : null;
  const signalsMd =
    contract.signalsMd.length > 0 ? `判读备注：${contract.signalsMd.join('')}` : null;
  const overnightMd = steady.overnightMd ? `昨夜交班：${steady.overnightMd}` : null;

  const trimmed = trimUnitsToBudget(
    [
      { rank: 0, markdown: contract.steeringMd },
      {
        rank: 0.5,
        markdown: steady.communicationMd ? `怎么和我说话：${steady.communicationMd}` : null,
        protected: true,
      },
      { rank: 1, markdown: renderDelta(delta) },
      { rank: 2, markdown: renderDueItems(delta.dueItems), dropRank: 8 },
      { rank: 3, markdown: masteryMd },
      { rank: 4, markdown: contract.failureDetailsMd, dropRank: 9 },
      { rank: 5, markdown: portraitMd },
      { rank: 6, markdown: signalsMd },
      { rank: 7, markdown: overnightMd },
    ],
    { maxEstimatedTokens: opts.budget ?? 1000, maxChars: 2400 },
  );

  return {
    view: 'companion',
    markdown: trimmed.markdown,
    estimatedTokens: trimmed.estimatedTokens,
    asOf: steady.asOf.toISOString(),
    asOfBasis: steady.asOfBasis,
  };
}
