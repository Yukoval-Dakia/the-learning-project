// 契约段（代码产出，全部来自已有读模型，不重复计算）：
//   - Steering：listActiveGoalsWithResolvedScope——steering goal 渲染今日页标题
//     （instruction_md）+ goal_id + 学习者原话（与标题不同时）+ 时间窗 + 未对应范围，
//     普通 goal 渲染「当前目标：title」（未开始的 steering goal 不占当前目标位）
//   - 掌握度：readLearnerJudgments 的白话档，含不确定度，uncalibrated 照实标注
//   - 错因：readCauseJudgment 的最近失败窗口，与单知识点工具同一排序
//   - 信号：判断批次的不确定备注；昨夜交班句
// 所有确定性数字带 n；n 不够写「样本少」，不给数字。

import { learnerLocalDay } from '@/core/learner-day';
import { A5_BANDS, masteryBandView } from '@/core/mastery-band';
import type { LearnerJudgmentBatch } from '@/core/schema/learner-judgment';
import {
  learnerDayWeekday,
  steeringDaysLeft,
  steeringStartsInDays,
  steeringWindowCoversToday,
} from '@/core/steering';
import type { Db, Tx } from '@/db/client';
import { readLearnerProfilesAsBatch } from '@/kernel/learner-profile';
import {
  type ActiveGoal,
  listActiveGoalsWithResolvedScope,
} from '@/kernel/read-models/active-goal-scope';
import { readCauseJudgment } from '@/kernel/read-models/cause-judgment';
import type { MasteryProjection } from '@/kernel/read-models/mastery-projection';
import { shanghaiLabel } from './delta';
import type { ContractSection } from './types';

type DbLike = Db | Tx;

const MIN_SAMPLE = 5;
/** 启动段只带最近几条失败原因，只有时间戳和归因标签。 */
const FAILURE_DETAIL_MAX = 3;

function summarizeMastery(proj: Map<string, MasteryProjection>): {
  masterySummary: string | null;
  meanTheta: number | null;
  observed: number;
} {
  const bandCounts = [0, 0, 0, 0];
  const thetas: number[] = [];
  for (const entry of proj.values()) {
    const view = masteryBandView(entry);
    if (view.unknown) continue;
    bandCounts[view.band] = (bandCounts[view.band] ?? 0) + 1;
    thetas.push(entry.theta_hat);
  }
  if (thetas.length === 0) return { masterySummary: null, meanTheta: null, observed: 0 };
  const parts: string[] = [];
  for (let b = A5_BANDS.length - 1; b >= 0; b -= 1) {
    if ((bandCounts[b] ?? 0) > 0) parts.push(`${A5_BANDS[b]}${bandCounts[b]}`);
  }
  return {
    masterySummary: parts.join(' '),
    meanTheta: thetas.reduce((s, t) => s + t, 0) / thetas.length,
    observed: thetas.length,
  };
}

/**
 * Split the incumbent plain-language judgment into the kept core (calibration
 * marking + mastery band, n-bearing) and the droppable signal notes.
 */
function summarizeJudgment(batch: LearnerJudgmentBatch): {
  masterySummary: string | null;
  meanTheta: number | null;
  observed: number;
  coreSentence: string;
  signalNotes: string[];
} {
  const observedMap = new Map<string, MasteryProjection>();
  let lowObserved = false;
  let insufficient = false;
  let notEvaluable = false;
  let unavailable = false;
  let growing = false;
  let undated = false;
  let unknownRetention = false;
  let divergentCount = 0;
  const readingEngines = new Set<string>();
  for (const item of batch.items) {
    switch (item.ability_claim.kind) {
      case 'low_observed':
        lowObserved = true;
        if (item.ability.kind === 'available')
          observedMap.set(item.knowledge_id, item.ability.reading);
        break;
      case 'observed':
        if (item.ability.kind === 'available')
          observedMap.set(item.knowledge_id, item.ability.reading);
        break;
      case 'insufficient_evidence':
        insufficient = true;
        break;
      case 'not_evaluable':
        notEvaluable = true;
        break;
      case 'unavailable':
        unavailable = true;
        break;
    }
    const age = item.uncertainty.evidence_age;
    if (age.kind === 'dated' && age.growing) growing = true;
    if (age.kind === 'undated') undated = true;
    if (
      item.retention.kind === 'unknown' ||
      (typeof item.retention.reading !== 'number' && item.retention.reading.kind === 'unknown')
    ) {
      unknownRetention = true;
    }
    if (item.retention.kind === 'available') readingEngines.add(item.retention.engine);
    if (item.uncertainty.component_disagreement.kind === 'divergence_observed') divergentCount += 1;
  }
  const engineName =
    readingEngines.size !== 1 || readingEngines.has('unknown')
      ? '实际引擎混合或未知'
      : readingEngines.has('fsrs')
        ? 'FSRS'
        : '候选遗忘引擎';
  const signalNotes = [
    lowObserved ? '有本人作答落在低掌握一侧（不会），这不是证据不足。' : '',
    insufficient ? '有知识点还不知道你会不会，不能当成不会或未训练。' : '',
    notEvaluable ? '有节点不评掌握，不计入会不会。' : '',
    unavailable ? '掌握读取失败，不能当成不会或不知道。' : '',
    growing ? '有作答已变旧，不确定在增大；这不是新的预测区间。' : '',
    undated ? '有作答缺少时间，不能判断不确定是否在增大。' : '',
    unknownRetention
      ? `保持：同范围存在未知项（${engineName}），不能据此断言记得或忘了。`
      : `保持：同范围现役读数可用（${engineName}），尚不能据此声称已校准或保持良好。`,
    divergentCount > 0 ? `读数分歧：${divergentCount} 项会做与保持两读数背离。` : '',
    '只作文字解读，不向学习者新增预测数字。',
  ].filter((note) => note.length > 0);
  return {
    ...summarizeMastery(observedMap),
    coreSentence: `共用判断 ${batch.version}：尚未个人校准（n=${batch.items.length}）。`,
    signalNotes,
  };
}

// steering goal 的一行：标题 + goal_id + 原话 + 时间窗（开始/截止/倒计时）+ 未对应范围。
// goal_id 让学伴在学习者说的是另一条（不是焦点那条）时能传对 id，不凭空猜。
// learner_words 上限 500 字、标题 280 字，启动段各按 120 字截断防占满预算。
function steeringLineForGoal(g: ActiveGoal, today: string): string {
  const steering = g.steering;
  if (steering === null) return `当前安排：${g.title}`;
  const clip = (text: string) => (text.length > 120 ? `${text.slice(0, 120)}…` : text);
  const title = clip(steering.instruction_md);
  const words =
    steering.learner_words === steering.instruction_md ? null : clip(steering.learner_words);
  const parts: string[] = [];
  if (g.effective_from !== null) {
    const startsIn = steeringStartsInDays(g.effective_from, today);
    if (startsIn !== null && startsIn > 0)
      parts.push(`${g.effective_from}（${learnerDayWeekday(g.effective_from)}）开始`);
  }
  if (g.effective_until !== null) {
    const daysLeft = steeringDaysLeft(g.effective_until, today);
    if (daysLeft !== null) {
      parts.push(
        daysLeft <= 0
          ? `就是今天（${g.effective_until}）`
          : `到 ${g.effective_until}（${learnerDayWeekday(g.effective_until)}）还有 ${daysLeft} 天`,
      );
    }
  }
  const unresolved =
    steering.scope_unresolved.length > 0 ? `；未对应：${steering.scope_unresolved.join('、')}` : '';
  const tail = parts.length > 0 ? `（${parts.join('，')}）` : '';
  const said = words === null ? '' : `；原话「${words}」`;
  return `当前安排「${title}」[goal_id=${g.id}]${tail}${said}${unresolved}`;
}

export async function readContractSection(
  db: DbLike,
  opts: { now: Date },
): Promise<ContractSection> {
  const [goals, causes] = await Promise.all([
    listActiveGoalsWithResolvedScope(db as Db),
    readCauseJudgment(db, { knowledge_ids: [], as_of: opts.now }),
  ]);

  const today = learnerLocalDay(opts.now);
  const steeringLines = goals
    .filter((g) => g.steering !== null && steeringWindowCoversToday(g, today))
    .map((g) => steeringLineForGoal(g, today));
  // 未开始的 steering goal 不占「当前目标」位（与普通 goal 并存时普通 goal 优先）。
  const activeGoal =
    goals.find((g) => g.steering === null) ??
    goals.find(
      (g) => !(g.steering !== null && g.effective_from !== null && g.effective_from > today),
    ) ??
    null;
  const ordinaryCount = goals.filter(
    (g) => !(g.steering !== null && g.effective_from !== null && g.effective_from > today),
  ).length;
  const goalLine = activeGoal
    ? `当前目标：${activeGoal.title}${ordinaryCount > 1 ? `（共 ${ordinaryCount} 个进行中目标）` : ''}`
    : null;
  const steeringParts = [...steeringLines, ...(goalLine ? [goalLine] : [])];
  const steeringMd = steeringParts.length === 0 ? null : steeringParts.join('\n');

  let masteryMd: string | null = null;
  let causesMd: string | null = null;
  let signalNotes: string[] = [];
  const scopeKcs = activeGoal?.scope_knowledge_ids ?? [];
  if (scopeKcs.length > 0) {
    const judgment = await readLearnerProfilesAsBatch(db, {
      knowledge_ids: scopeKcs,
      context: 'any',
      as_of: opts.now,
    });
    const sum = summarizeJudgment(judgment);
    signalNotes = sum.signalNotes;
    if (sum.masterySummary !== null && sum.observed >= MIN_SAMPLE) {
      masteryMd = `掌握度：${sum.masterySummary}（n=${sum.observed}）`;
    } else {
      masteryMd = '掌握度：样本少，暂不读数';
    }
    masteryMd = `${masteryMd} ${sum.coreSentence}`;
  }

  if (causes.recent_top_causes.length > 0) {
    causesMd =
      causes.recent_failure_count < MIN_SAMPLE
        ? '近期高频误区：样本少'
        : `近期高频误区：${causes.recent_top_causes.map((c) => `${c.category}（n=${c.count}）`).join('、')}`;
  }

  // 最近几条失败的逐条原因：只有时间戳 + 错因类别标签（misc_ 显示回填），
  // 未归因照实标注。错答正文和学习者原话不进常驻启动上下文。明细独立成
  // unit，预算紧时先于基础段被裁（见 budget.ts dropRank）。
  const failureLines = causes.recent_failures.slice(0, FAILURE_DETAIL_MAX).map((failure) => {
    const label = failure.label ?? failure.category ?? '未归因';
    return `· ${shanghaiLabel(failure.at)} ${label}`;
  });
  const failureDetailsMd = failureLines.length > 0 ? failureLines.join('\n') : null;

  return {
    steeringMd,
    masteryMd,
    causesMd,
    failureDetailsMd,
    signalsMd: signalNotes,
    overnightMd: null,
  };
}
