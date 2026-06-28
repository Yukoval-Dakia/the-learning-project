// YUK-354 (A2) — 解题会话「6 阶 hint 强度梯」的纯前端模型。
//
// owner 锁定的形态：把 PfCoach 抽屉里「无级线性、点一次给一条」的提示流，升级成**可感知的
// 6 阶 H0-H5 强度梯**（位置可见 + 强度爬升 + 一步逃生口 + H5 看完整解=非独立确认门）。详见
// docs/design/2026-06-28-form-axis-A2-handoff.md「锁定的 6 阶梯」表 + 硬功能约束。
//
// 关键：**6 阶是前端在既有 `hint_index` 之上的纯映射**——后端 solve/hint 接口仍是单一数字
// `hint_index`（src/capabilities/practice/server/solve-session.ts:buildSolveHintInput）。本表把
// 阶 H0-H4 直映射成 hint_index 0-4（既有 solveHint 调用的 index），H5「完整解」不是 hint 调用——它是
// question.reference_md 的 reveal（逃生口），不碰后端 hint 生成逻辑。把每阶 prompt 改成按 H0-H5
// 生成分阶帮助是后端增量，OUT-OF-SCOPE（见 handoff §不在本增量范围）。
//
// independence 列只到 H5 非独立确认门为止落地（逃生口锁定项 entail 的）；H0-H4 的 独立/半独立
// 三态追踪 infra 是 handoff 提议、owner 未拍（见「锁定范围澄清」callout）→ 本模型只描述语义，
// 不写库、不接 commit/review 契约。

/** 每阶的独立性语义（display-only — 不持久化、不进判分契约；仅 H5 非独立驱动确认门）。 */
export type StageIndependence = 'independent' | 'semi' | 'non';

export interface HintStage {
  /** 阶 id H0..H5（owner 锁定的 6 阶）。 */
  key: string;
  /** 给 owner 看的短标签（措辞 owner 可微调）。 */
  label: string;
  /** 强度档位描述（最轻 → 完整解，让 6 阶可感知）。 */
  weight: string;
  /** 这一阶给什么「性质」的帮助（非具体内容）—— 用于「下一阶性质可预知、不剧透」预告。 */
  gives: string;
  /** 该阶独立性语义（display-only；仅 H5='non' 驱动非独立确认门）。 */
  independence: StageIndependence;
  /** 仅终点完整解阶（H5）为 true —— 它是逃生口的 reveal，非 hint 调用。 */
  isFull: boolean;
}

// owner 锁定的 6 阶 H0-H5（handoff「锁定的 6 阶梯」表，强度从上到下递增）。
// label/gives 措辞是 owner 留白，取自 handoff 表的「性质」列 + 设计源 data-hint-ladder.jsx。
export const HINT_LADDER: readonly HintStage[] = [
  {
    key: 'H0',
    label: '元认知',
    weight: '最轻',
    gives: '只问你卡在哪一步、这类题一般怎么下手 —— 不碰题目内容',
    independence: 'independent',
    isFull: false,
  },
  {
    key: 'H1',
    label: '方向',
    weight: '轻',
    gives: '指一个大方向 / 该调用哪块知识，不给具体步骤',
    independence: 'independent',
    isFull: false,
  },
  {
    key: 'H2',
    label: '概念',
    weight: '中',
    gives: '点明关键概念 / 定理 / 公式，仍不代入本题',
    independence: 'independent',
    isFull: false,
  },
  {
    key: 'H3',
    label: '错因',
    weight: '偏重',
    gives: '针对你当前思路指出卡点 / 常见误区',
    independence: 'independent',
    isFull: false,
  },
  {
    key: 'H4',
    label: '部分示范',
    weight: '重',
    gives: '演示关键一步怎么做，剩下留给你收尾',
    independence: 'semi',
    isFull: false,
  },
  {
    key: 'H5',
    label: '完整解',
    weight: '完整解',
    gives: '给出完整解答与理由',
    independence: 'non',
    isFull: true,
  },
];

/** 总阶数（6）—— 位置刻度「共 N 阶」用。 */
export const LADDER_SIZE = HINT_LADDER.length;

/** 完整解阶（H5）的索引（5）。逃生口一步跳到此阶。 */
export const FULL_STAGE_INDEX = HINT_LADDER.findIndex((s) => s.isFull);

/**
 * 最高的 hint 阶索引（H4 = 4）—— 即后端 solveHint 接受的最大 hint_index（本梯只用 0-4；
 * H5 不是 hint 调用）。远低于后端 `MAX_HINT_INDEX=20` cap，故梯内永不触发后端 exhausted 路径。
 */
export const LAST_HINT_INDEX = FULL_STAGE_INDEX - 1;

/** 阶梯量程标签（rail head 用），如「H0–H5」。 */
export const LADDER_RANGE_LABEL = `${HINT_LADDER[0].key}–${HINT_LADDER[FULL_STAGE_INDEX].key}`;

/** 取指定索引的阶（越界 → undefined）。 */
export function stageAt(index: number): HintStage | undefined {
  return HINT_LADDER[index];
}

/**
 * rail 右侧的位置标签：「尚未开始」/「第 H2 阶」/「已看完整解」。
 * reached < 0 ≡ 尚未要任何提示；revealedFull ≡ 已 reveal 完整解（H5）。
 */
export function positionLabel(reached: number, revealedFull: boolean): string {
  if (revealedFull) return '已看完整解';
  if (reached < 0) return '尚未开始';
  const stage = HINT_LADDER[reached];
  return stage ? `第 ${stage.key} 阶` : '尚未开始';
}

/**
 * 下一个**可逐阶推进**的 hint 阶（H0-H4）。单调递进不跳级：只返回 reached 的紧邻下一阶，
 * 且**绝不返回完整解阶**——H5 只能走逃生口（显式独立动作），不能由「再给一阶」滑到。
 *   - reached = -1（尚未开始）→ 返回 H0（首次推进 = 最轻一阶）。
 *   - reached = LAST_HINT_INDEX（H4）→ 下一阶是 H5（isFull）→ 返回 undefined（此后只剩逃生口）。
 */
export function nextHintStage(reached: number): HintStage | undefined {
  const next = HINT_LADDER[reached + 1];
  return next && !next.isFull ? next : undefined;
}

/**
 * 完整解（H5）是否有可展示内容。本梯的完整解内容源 = question.reference_md（已在 client-side
 * QuestionDetail prop 里；solveStart 的懒生成会 merge-preserving 写回该字段，但 solo 流的薄
 * prop 不重取——故 null 时走诚实空态，「把懒生成的解 surface 到 solo 流」是 follow-up）。
 * 空/全空白 → H5 逃生口必须显式置不可用（不给死按钮、不编造完整解）。
 */
export function isFullSolutionAvailable(referenceMd: string | null | undefined): boolean {
  return typeof referenceMd === 'string' && referenceMd.trim().length > 0;
}
