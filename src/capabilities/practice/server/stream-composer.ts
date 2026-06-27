// M2 (YUK-316) — composeDailyStream：流编排器纯函数核心（P2 spec §2.1）。
// 零 IO：输入由薄壳（stream-store.ts）收集——FSRS 到期投影来自 due-list（现有
// 逻辑降级为输入信号，不删除）、错题变体轮换、新学待检、当日待做卷。
// 跨学科 round-robin 不在此重做：due-list 内部已对到期池做过学科平衡。
//
// 混排规则（与 stream-composer.unit.test.ts 互为 spec；顺序习惯源自设计稿
// docs/design/loom-refresh 的 PFACE.items 形状）：
//   R1 热身：有 decay 时流首必是 decay
//   R2 variant 穿插散题段中（decay 主轴每 2 道插 1 变式，剩余追加段尾）
//   R3 卷置于散题之后；new_check 永远收尾
//   R4 同 questionId 去重（decay 先到先得）
//   R5 容量护栏两层：warn 水位只告知（warned），max 硬顶截断（truncated）
//   R6 position 从 1 连续；R7 reasoning 模板非空（M4 夜链 AI 化后替换模板）

export interface ComposerInputs {
  /** YYYY-MM-DD（本地日由 API 层裁定） */
  date: string;
  /** FSRS 到期投影（due-list rows 的最小投影；已跨学科平衡） */
  dueItems: Array<{ questionId: string; knowledgeLabel?: string; dueAt?: string }>;
  /** 错题变式（近期失败题的变体轮换选题） */
  variantItems: Array<{ questionId: string; rootQuestionId: string; knowledgeLabel?: string }>;
  /** 新学待检（learning_item 路径上未检验的知识点自测题） */
  newCheckItems: Array<{ questionId: string; knowledgeId: string; knowledgeLabel?: string }>;
  /**
   * B3 learnable_frontier（YUK-349 #3，ADR-0037 #4）——前置全掌握、自身未掌握的「可学前沿」
   * KC 各取一道题。**OPTIONAL**：现有 caller/测试不传 → undefined → 零新增项（NO-OP，
   * 输出 byte-identical）。稀疏先决图上 learnableFrontier 返 [] → 此处恒空（defer-flip）。
   */
  frontierItems?: Array<{ questionId: string; knowledgeId: string; knowledgeLabel?: string }>;
  /** 当日待做卷（AI 打包 / 点播 / 导入） */
  pendingPapers: Array<{
    paperId: string;
    title: string;
    source: 'paper' | 'on_demand' | 'import';
  }>;
  /** 容量护栏（两层语义：warn 零干预只告知；max 防事故硬顶） */
  capacity?: { warn?: number; max?: number };
}

export interface StreamPlanItem {
  position: number;
  item_kind: 'question' | 'paper';
  ref_id: string;
  source: 'decay' | 'variant' | 'new_check' | 'paper' | 'on_demand' | 'import' | 'frontier';
  reasoning: string;
  // YUK-361 Phase 1（观测先行）— 选题信号快照（SelectionCandidateSignal 形态）。
  // **零行为变更**：本 lane 不计算、不据此排序，materializeStream 落库时缺省 {}；
  // 值由 Phase 3 候选收集层填充。
  signals?: Record<string, unknown>;
}

export interface StreamPlan {
  date: string;
  items: StreamPlanItem[];
  truncated: boolean;
  warned: boolean;
}

const DEFAULT_WARN = 12;
const DEFAULT_MAX = 30;

function kpSuffix(label?: string): string {
  return label ? `「${label}」` : '这一块';
}

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
      source: 'decay',
      reasoning: `我看了你的曲线：${kpSuffix(d.knowledgeLabel)}到了复习边缘，先把它咬住。`,
    });
    if ((i + 1) % 2 === 0 && vi < vars.length) {
      const v = vars[vi++];
      solo.push({
        item_kind: 'question',
        ref_id: v.questionId,
        source: 'variant',
        reasoning: `之前${kpSuffix(v.knowledgeLabel)}翻过车，这道换了说法再来一次。`,
      });
    }
  }
  for (; vi < vars.length; vi++) {
    const v = vars[vi];
    solo.push({
      item_kind: 'question',
      ref_id: v.questionId,
      source: 'variant',
      reasoning: `之前${kpSuffix(v.knowledgeLabel)}翻过车，这道换了说法再来一次。`,
    });
  }

  // R3：卷置于散题之后。
  const papers: Draft[] = inputs.pendingPapers.map((p) => ({
    item_kind: 'paper',
    ref_id: p.paperId,
    source: p.source,
    reasoning:
      p.source === 'on_demand'
        ? `你点播的「${p.title}」排好了——卷内不给即时反馈，交卷统一判。`
        : p.source === 'import'
          ? `你导入的「${p.title}」在待做里——交卷后统一判分。`
          : `散题做完后用「${p.title}」收口——卷内不给即时反馈，交卷统一判。`,
  }));

  // new_check 收尾。
  const tail: Draft[] = checks.map((n) => ({
    item_kind: 'question',
    ref_id: n.questionId,
    source: 'new_check',
    reasoning: `你刚学了${kpSuffix(n.knowledgeLabel)}，自测一道确认真的进脑子了。`,
  }));

  // B3 frontier 尾（在 new_check 之后追加）。fronts 空 → 零项 → all 与改前逐字相同。
  const frontierTail: Draft[] = fronts.map((f) => ({
    item_kind: 'question',
    ref_id: f.questionId,
    source: 'frontier',
    reasoning: `${kpSuffix(f.knowledgeLabel)}的前置你都拿下了，可以开这块新内容了。`,
  }));

  const all = [...solo, ...papers, ...tail, ...frontierTail];
  const truncated = all.length > max;
  const kept = truncated ? all.slice(0, max) : all;

  return {
    date: inputs.date,
    items: kept.map((d, i) => ({ ...d, position: i + 1 })),
    truncated,
    warned: all.length > warn,
  };
}
