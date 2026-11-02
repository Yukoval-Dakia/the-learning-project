// composeDailyStream: pure stream composition core. No IO; input is collected by
// stream-store.
//
// Order: decay warm-up first; variants interleaved every two decay items with the rest at
// the tail; papers after loose items; new_check last; question ids deduped; the minutes
// budget protects the due prefix then fills the rest; positions are contiguous from 1 and
// reasoning templates are never empty. L3 learning-mix repairs repetition fatigue and adds
// frontier-floor diagnostics.

import {
  type LearningMixDiagnostic,
  applyL3LearningMixGuard,
  learningMixContextFromInputs,
} from './post-filter';
import { fitStreamToTimeBudget } from './stream-budget';
import {
  presentDueQuestion,
  presentNonDueQuestion,
  presentPracticePaper,
} from './stream-item-presentation';

interface ComposerQuestionMetadata {
  knowledgeId?: string;
  questionKind?: string;
}

export interface ComposerInputs {
  /** YYYY-MM-DD（本地日由 API 层裁定） */
  date: string;
  /** FSRS 到期投影（due-list rows 的最小投影；已跨学科平衡） */
  dueItems: Array<
    {
      questionId: string;
      knowledgeLabel?: string;
      dueAt?: string;
      source?: 'decay' | 'intervention';
    } & ComposerQuestionMetadata
  >;
  /** 错题变式（近期失败题的变体轮换选题） */
  variantItems: Array<
    {
      questionId: string;
      rootQuestionId: string;
      knowledgeLabel?: string;
    } & ComposerQuestionMetadata
  >;
  /** 新学待检（learning_item 路径上未检验的知识点自测题） */
  newCheckItems: Array<
    { questionId: string; knowledgeId: string; knowledgeLabel?: string } & ComposerQuestionMetadata
  >;
  /**
   * B3 learnable_frontier（#3， #4）——前置全掌握、自身未掌握的「可学前沿」
   * KC 各取一道题。**OPTIONAL**：现有 caller/测试不传 → undefined → 零新增项（NO-OP，
   * 输出 byte-identical）。稀疏先决图上 learnableFrontier 返 [] → 此处恒空（defer-flip）。
   */
  frontierItems?: Array<
    { questionId: string; knowledgeId: string; knowledgeLabel?: string } & ComposerQuestionMetadata
  >;
  /** 当日待做卷（AI 打包 / 点播 / 导入） */
  pendingPapers: Array<{
    paperId: string;
    title: string;
    source: 'paper' | 'on_demand' | 'import';
  }>;
  /** 容量护栏（两层语义：warn 零干预只告知；max 防事故硬顶） */
  capacity?: { warn?: number; max?: number };
  /** 用户 daily pace 映射出的分钟预算；缺省仅供旧测试/显式 DI 保持旧行为。 */
  dailyBudgetMinutes?: number;
  /** 实测/默认单题用时；缺省时沿用 的 2 分钟。 */
  questionMinutes?: number;
}

export interface StreamPlanItem {
  position: number;
  item_kind: 'question' | 'paper';
  ref_id: string;
  source:
    | 'decay'
    | 'variant'
    | 'new_check'
    | 'paper'
    | 'on_demand'
    | 'import'
    | 'frontier'
    | 'intervention';
  reasoning: string;
  // （观测先行）— 选题信号快照（SelectionCandidateSignal 形态）。
  // **零行为变更**：本 lane 不计算、不据此排序，materializeStream 落库时缺省 {}；
  // 值由 候选收集层填充。
  signals?: Record<string, unknown>;
}

export interface StreamPlan {
  date: string;
  items: StreamPlanItem[];
  truncated: boolean;
  warned: boolean;
  /** structured stream-level L3 degradation signals; omitted when the mix is healthy. */
  diagnostics?: LearningMixDiagnostic[];
}

const DEFAULT_WARN = 12;
const DEFAULT_MAX = 30;

export function composeDailyStream(inputs: ComposerInputs): StreamPlan {
  const warn = inputs.capacity?.warn ?? DEFAULT_WARN;
  const max = inputs.capacity?.max ?? DEFAULT_MAX;

  // R4 去重：decay 先到先得；variant/new_check 不与已排题重复。
  const seen = new Set<string>();
  const dues = inputs.dueItems.filter((d) => !seen.has(d.questionId) && seen.add(d.questionId));
  const vars = inputs.variantItems.filter((v) => !seen.has(v.questionId) && seen.add(v.questionId));
  const checks = inputs.newCheckItems.filter(
    (n) => !seen.has(n.questionId) && seen.add(n.questionId),
  );
  // B3 frontier（additive 5th source）：dedup 在 new_check 之后——已排过的题不重复。
  // frontierItems 缺省/[] → fronts=[] → 零新增项（NO-OP，输出 byte-identical）。
  const fronts = (inputs.frontierItems ?? []).filter(
    (f) => !seen.has(f.questionId) && seen.add(f.questionId),
  );

  type Draft = Omit<StreamPlanItem, 'position'>;
  const solo: Draft[] = [];

  // R1+R2：decay 主轴，每 2 道 decay 后穿插 1 道 variant；variant 余量追加段尾。
  let vi = 0;
  for (const [i, d] of dues.entries()) {
    solo.push({
      item_kind: 'question',
      ref_id: d.questionId,
      ...presentDueQuestion(d.knowledgeLabel, d.source),
    });
    if ((i + 1) % 2 === 0 && vi < vars.length) {
      const v = vars[vi++];
      solo.push({
        item_kind: 'question',
        ref_id: v.questionId,
        ...presentNonDueQuestion('variant', v.knowledgeLabel),
      });
    }
  }
  for (; vi < vars.length; vi++) {
    const v = vars[vi];
    solo.push({
      item_kind: 'question',
      ref_id: v.questionId,
      ...presentNonDueQuestion('variant', v.knowledgeLabel),
    });
  }

  // R3：卷置于散题之后。
  const papers: Draft[] = inputs.pendingPapers.map((p) => ({
    item_kind: 'paper',
    ref_id: p.paperId,
    ...presentPracticePaper(p.title, p.source),
  }));

  // new_check 收尾。
  const tail: Draft[] = checks.map((n) => ({
    item_kind: 'question',
    ref_id: n.questionId,
    ...presentNonDueQuestion('new_check', n.knowledgeLabel),
  }));

  // B3 frontier 尾（在 new_check 之后追加）。fronts 空 → 零项 → all 与改前逐字相同。
  const frontierTail: Draft[] = fronts.map((f) => ({
    item_kind: 'question',
    ref_id: f.questionId,
    ...presentNonDueQuestion('frontier', f.knowledgeLabel),
  }));

  const all = [...solo, ...papers, ...tail, ...frontierTail];
  const budgeted = fitStreamToTimeBudget(all, inputs.dailyBudgetMinutes, inputs.questionMinutes);
  const protectedIndexes = budgeted.kept.flatMap((item, index) =>
    item.source === 'intervention' ? [index] : [],
  );
  const optionalSlots = Math.max(0, max - protectedIndexes.length);
  const optionalIndexes = budgeted.kept.flatMap((item, index) =>
    item.source !== 'intervention' ? [index] : [],
  );
  const retainedIndexes = new Set([
    ...protectedIndexes,
    ...optionalIndexes.slice(0, optionalSlots),
  ]);
  const kept = budgeted.kept.filter((_, index) => retainedIndexes.has(index));
  const overItemMax = kept.length < budgeted.kept.length;

  const plan: StreamPlan = {
    date: inputs.date,
    items: kept.map((d, i) => ({ ...d, position: i + 1 })),
    truncated: budgeted.truncated || overItemMax,
    warned: all.length > warn || budgeted.truncated,
  };
  return applyL3LearningMixGuard(plan, learningMixContextFromInputs(inputs, frontierTail.length));
}
