// companion view（B1 唯一落地 view）：三段装配 + 按优先级裁剪到 ≤1000 估计 token。
// 渲染序即文档序；裁剪序：Steering > Δ > 掌握和错因 > 稳态画像 > 便条 > 信号 > 昨夜，
// 到期题明细与失败明细（§13 给「怎么和我说话」留空间）最先被裁。被裁单元的名字
// 以一行省略说明留在 header 末尾，模型不会把裁剪后的段落当成全部。

import type { ContextViewName } from '@/ai/task-spec';
import { wrapUntrustedLearnerText } from '@/capabilities/agency/server/conjecture/untrusted-text';
import type { Db, Tx } from '@/db/client';
import type { AgentNote } from '@/kernel/read-models/agent-note-hints';
import type { LearnerContextResult } from '@/kernel/read-models/learner-context';
import type { LearnerCurriculum } from '@/kernel/read-models/learner-curriculum';
import { readLearnerCurriculum } from '@/kernel/read-models/learner-curriculum';
import { readCompanionAgentNotes, renderAgentNotes } from './agent-notes';
import { type TrimUnit, trimUnitsToBudget } from './budget';
import { readContractSection } from './contract';
import { DELTA_SCAN_LIMIT, readDeltaSection, shanghaiLabel } from './delta';
import { DELTA_FALLBACK_LOOKBACK_MS, readSteadySection } from './steady';
import type { ContractSection, DeltaSection, DueItemLine, SteadySection } from './types';

type DbLike = Db | Tx;

const FAILURE_STREAK_HEADER_MIN = 3;

const LOOKBACK_DAYS = Math.round(DELTA_FALLBACK_LOOKBACK_MS / (24 * 60 * 60 * 1000));

function renderDelta(delta: DeltaSection): string {
  const lines: string[] = [];
  const c = delta.counts;
  const windowLabel = delta.countsWindowLimited ? `（最近${DELTA_SCAN_LIMIT}条候选活动内）` : '';

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
  lines.push(
    parts.length > 0
      ? `${scope}${windowLabel}：${parts.join('，')}`
      : `${scope}暂无新学习动态${windowLabel}`,
  );
  for (const line of delta.recent) lines.push(`· ${shanghaiLabel(line.at)} ${line.label}`);
  const tail = [
    `今日待复习 ${delta.reviewDueOverCap ? `${delta.reviewDueCount}+` : delta.reviewDueCount} 项`,
  ];
  if (delta.failureStreak && delta.failureStreak.count >= FAILURE_STREAK_HEADER_MIN) {
    tail.push(`连续答错：${delta.failureStreak.knowledge_name}（${delta.failureStreak.count} 次）`);
  }
  if (delta.lastActivityAt) tail.push(`最近活动 ${shanghaiLabel(delta.lastActivityAt)}`);
  lines.push(tail.join('；'));
  if (delta.mixNote) lines.push(delta.mixNote);
  return lines.join('\n');
}

/** 省掉的单元写进 header：模型知道有内容被预算裁掉，而不是以为那就是全部。 */
function formatOmissionNotice(labels: readonly string[], hiddenCount: number): string {
  const named = labels.map((label) => `「${label}」`).join('');
  if (named.length === 0) {
    return hiddenCount > 0 ? '（另有内容因篇幅省略，需要时用对应读取工具取）' : '';
  }
  const total = labels.length + hiddenCount;
  return hiddenCount > 0
    ? `（因篇幅省略：${named} 等 ${total} 项，需要时用对应读取工具取）`
    : `（因篇幅省略：${named}，需要时用对应读取工具取）`;
}

// 题干摘录是学习者文本（prompt_md 属仓库红线的 learner-authored text），整段
// 明细包一次 <untrusted_learner_text> 定界——逐条已截断（先截断再包裹），
// 定界符也计入启动段预算（trim 测的是包裹后的 markdown）。
function renderDueItems(items: DueItemLine[]): string | null {
  if (items.length === 0) return null;
  const block = items
    .map((item) => {
      const kcs = item.knowledgeNames.length > 0 ? `（${item.knowledgeNames.join('、')}）` : '';
      return `· ${item.stem}${kcs}`;
    })
    .join('\n');
  return wrapUntrustedLearnerText(block);
}

/** The rendered units in render order; trimming (not this builder) decides what fits. */
export function buildCompanionUnits(input: {
  steady: SteadySection;
  curriculum: LearnerCurriculum;
  delta: DeltaSection;
  contract: ContractSection;
  agentNotes: readonly AgentNote[];
}): TrimUnit[] {
  const { steady, curriculum, delta, contract, agentNotes } = input;
  const masteryMd = [contract.masteryMd, contract.causesMd].filter(Boolean).join('\n') || null;
  const portraitMd = steady.portraitMd ? `画像：${steady.portraitMd}` : null;
  const signalsMd =
    contract.signalsMd.length > 0 ? `判读备注：${contract.signalsMd.join('')}` : null;
  const overnightMd = steady.overnightMd ? `昨夜交班：${steady.overnightMd}` : null;

  return [
    { rank: 0, name: 'steering', label: '学习目标', markdown: contract.steeringMd },
    {
      rank: 0.2,
      name: 'curriculum',
      label: '学段',
      markdown: curriculum.stage_md,
      protected: true,
    },
    // The preference list is a light bias, not a constraint: it is the first thing
    // dropped when the budget is tight, so it never squeezes steering or mastery.
    {
      rank: 0.3,
      name: 'curriculum_preferences',
      label: '学科偏好',
      markdown: curriculum.preferences_md,
      dropRank: 10,
    },
    {
      rank: 0.5,
      name: 'communication',
      label: '沟通偏好',
      markdown: steady.communicationMd ? `怎么和我说话：${steady.communicationMd}` : null,
      protected: true,
    },
    { rank: 1, name: 'delta', label: '近期动态', markdown: renderDelta(delta) },
    {
      rank: 2,
      name: 'due_details',
      label: '到期题明细',
      markdown: renderDueItems(delta.dueItems),
      dropRank: 8,
    },
    { rank: 3, name: 'mastery_causes', label: '掌握和错因', markdown: masteryMd },
    {
      rank: 4,
      name: 'failure_details',
      label: '失败明细',
      markdown: contract.failureDetailsMd,
      dropRank: 9,
    },
    // 画像保持 rank 5，不额外 protected：预算真不够时它仍按文档顺序让位（掌握度
    // 更重要），但 steady.ts 的 200 字符上限让它不再自己把整段画像顶出启动段。
    { rank: 5, name: 'portrait', label: '画像', markdown: portraitMd },
    // 便条排在画像之后、判读备注之前：它是线索，不该挤掉画像或掌握度。
    { rank: 5.5, name: 'agent_notes', label: '便条', markdown: renderAgentNotes(agentNotes) },
    { rank: 6, name: 'signals', label: '判读备注', markdown: signalsMd },
    { rank: 7, name: 'overnight', label: '昨夜交班', markdown: overnightMd },
  ];
}

/**
 * The companion startup segment: three sections read from existing read models,
 * rendered then deterministically trimmed to the view budget. The three reads
 * are independent (not one snapshot); the segment is an advisory attention
 * prior, so mild read skew is acceptable.
 */
export async function assembleCompanionContext(
  db: DbLike,
  opts: { now: Date; budget?: number; view?: ContextViewName },
): Promise<LearnerContextResult> {
  const view = opts.view ?? 'companion';
  const [steady, curriculum] = await Promise.all([
    readSteadySection(db, { now: opts.now }),
    readLearnerCurriculum(db),
  ]);
  const [delta, contract] = await Promise.all([
    readDeltaSection(db, { asOf: steady.asOf, asOfBasis: steady.asOfBasis, now: opts.now }),
    readContractSection(db, { now: opts.now }),
  ]);
  // 便条是写给学伴的 AI 线索；curator 的整理轮不消费这条信道。
  const agentNotes = view === 'companion' ? await readCompanionAgentNotes(db, opts.now) : [];

  const trimmed = trimUnitsToBudget(
    buildCompanionUnits({ steady, curriculum, delta, contract, agentNotes }),
    { maxEstimatedTokens: opts.budget ?? 1000, maxChars: 2400 },
    formatOmissionNotice,
  );

  return {
    view,
    markdown: trimmed.markdown,
    estimatedTokens: trimmed.estimatedTokens,
    startupTrim: {
      droppedUnits: trimmed.droppedUnits,
      tokensBeforeTrim: trimmed.tokensBeforeTrim,
    },
    asOf: steady.asOf.toISOString(),
    asOfBasis: steady.asOfBasis,
  };
}
