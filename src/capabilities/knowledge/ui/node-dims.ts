// A5 S3 (YUK-354) — NodeComposite three-dim fold pure logic（⑥治理 + 三轴正交）.
//
// 把焦点节点的 RAW 读模型（p(L) 投影 + 代表性 β + R 可提取性 + evidence 计数）组装成
// 三条 ORTHOGONAL 维度的离散 band 展示视图。每维走「档 + 区间 + 来源二态(hard/soft) +
// 低置信」（复用 S1 mastery-band 语言），绝不裸数字。
//
// 三轴正交（ADR-0035 红线）—— 纯 READ-side 展示派生，绝不写回任何轴：
//   - R   记忆留存  = FSRS retrievability（会不会忘）。0-1 域，复用 masteryBandIdx。
//   - p(L) 掌握诊断 = PFA σ(θ̂)（会不会）。真 σ 区间（mastery_lo/hi）+ low_confidence。
//   - diff 题目难度 = item_calibration β（题对你多难）。logit 尺度，单独阈值映射。
// R / p(L) / diff 互不读写对方——本模块只把三个已读好的 RAW 输入各自 band 化并列。
//
// ⚠️ β→difficulty band 的尺度依据（ground 自代码，非臆测）：
//   β = getRepresentativeKcBeta 的 hard-track 题 COALESCE(b_calib,b_anchor,b) 中位数，
//   IRT 1PL logit b 尺度。owner-fixed 锚桶（fixed-anchor.ts ANCHOR_BUCKET_LOGITS）
//   跨 logit [-2,+2]：very_easy=-2 / easy=-1 / medium=0 / hard=1 / very_hard=2，
//   与 difficultyToLogitB（theta.ts，每档 ~0.85 logit）同量级。β=0 = 中性难度原点；
//   是否有锚由独立 difficultyAnchored presence bit 表达，不再与 default sentinel 混叠。
//   NOTE: β 是绝对题目锚难度（非「相对你当前 θ̂」）——相对-θ 的 IRT 区分度展示属于
//   DiagnosticDrill（无后端，诚实空态），不在此三维里假造。

import {
  A5_BANDS,
  type MasteryBandIdx,
  type MasteryBandInput,
  type MasteryBandView,
  UNKNOWN_BAND_LABEL,
  masteryBandIdx,
  masteryBandUnknown,
  masteryBandView,
} from '@/core/mastery-band';

// 维度 key（同屏并列，绝不合并——三轴正交）。
export type NodeDimKey = 'R' | 'pL' | 'diff';

// 难度 4 档名（difficulty 轴专用——绝不复用 p(L) 的萌芽/成长/稳固/精熟，
// 那会把「题目难度」渲成掌握进度档，语义错位。结构语言（离散档/来源/低置信/区间）
// 仍复用 S1 BandChip，只 label 串按轴语义换）。band 越高 = 越难。
export const DIFFICULTY_BANDS = ['容易', '适中', '偏难', '很难'] as const;

// β(logit) → 4 档难度阈值（具名常量；每值是对应更难档的下界）。对齐 owner-fixed
// 锚桶尺度 [-2,+2]（medium=0）：容易<-0.5 ≤ 适中<0.5 ≤ 偏难<1.5 ≤ 很难。
export const DIFFICULTY_BETA_THRESHOLDS = {
  /** 容易 < -0.5 ≤ 适中（涵盖 very_easy=-2 / easy=-1） */
  moderate: -0.5,
  /** 适中 < 0.5 ≤ 偏难（涵盖 medium=0） */
  hard: 0.5,
  /** 偏难 < 1.5 ≤ 很难（涵盖 hard=1 / very_hard=2） */
  veryHard: 1.5,
} as const;

// evidence 低于此 → 显示慢热冷启告示（绝对值多半还是模型先验，不是练出来的）。
// 设计源 firm 档（9 evidence）无告示、warming（4）/ blind（3）有 → 6 为干净切点。
export const COLD_NOTE_MAX_EVIDENCE = 6;

/** β(logit) → 4 档难度 band idx。band 越高越难。 */
export function difficultyBandIdx(beta: number): MasteryBandIdx {
  if (beta < DIFFICULTY_BETA_THRESHOLDS.moderate) return 0;
  if (beta < DIFFICULTY_BETA_THRESHOLDS.hard) return 1;
  if (beta < DIFFICULTY_BETA_THRESHOLDS.veryHard) return 2;
  return 3;
}

// 一条维度的展示视图：band view（判别式：unknown vs 有据）+ 该轴的 label 串 + note。
// 前端三维卡用 labels 渲档名（R/pL 用 A5_BANDS，diff 用 DIFFICULTY_BANDS）。
export interface NodeDimView {
  key: NodeDimKey;
  label: string;
  view: MasteryBandView;
  /** 该轴的 4 档名（band idx → 档名映射；BandChipView 据此渲）。 */
  labels: readonly string[];
  unknownLabel: string;
  note?: string;
}

export interface NodeThreeDim {
  /** 综合掌握（= p(L) 视图）——折叠为单标量的那一档，hero 下方主显。 */
  composite: MasteryBandView;
  /** 展开的三维（顺序 R → p(L) → diff，同屏并列）。 */
  dims: NodeDimView[];
  /** 慢热冷启告示（证据少时显，否则 null）。 */
  coldNote: string | null;
}

// 三维 RAW 输入——node-page 读好后平铺过 wire，前端组装（同 S1 raw-over-wire 先例：
// node-page 出 mastery_lo/hi/low_confidence/evidence_count，BandChip 客户端 band 化）。
export interface NodeThreeDimInput {
  /** p(L) 投影 band 输入（mastery==null 或整体 null = 焦点冷启，never-attempted）。 */
  mastery: MasteryBandInput | null;
  /** 代表性 β（logit）；真实锚可在 learner mastery 投影出现前读取。 */
  beta: number | null;
  /** hard-track 代表性 β 的 map presence；false 时即使 beta=0 也必须 under-claim。 */
  difficultyAnchored: boolean;
  /** R 可提取性 ∈[0,1]，null = 无 fsrs_state 行（无留存数据，非 R=0）。 */
  retrievability: number | null;
  /** evidence 计数（驱动冷启告示）。无投影 → 0。 */
  evidenceCount: number;
}

// hard-source 点 band 视图（R / difficulty 共用）：无 CI 数据 → loBand=hiBand=band（点 band，
// 不伪造区间精度），source=hard，非低置信。两 builder 逐字重复过（OCR），抽出单一真相。
function hardPointBand(band: MasteryBandIdx): MasteryBandView {
  return { unknown: false, band, loBand: band, hiBand: band, source: 'hard', lowConf: false };
}

// R 维：有 fsrs_state（retrievability 非 null）→ band=masteryBandIdx(R)，source=hard，
// 无区间（点 band，不伪造精度）；无行 → 未知 + soft + 低置信（非 band 0）。
function buildRetentionDim(retrievability: number | null): NodeDimView {
  const base = {
    key: 'R' as const,
    label: '记忆保持',
    labels: A5_BANDS,
    unknownLabel: UNKNOWN_BAND_LABEL,
  };
  if (retrievability == null) {
    return {
      ...base,
      view: masteryBandUnknown(),
      note: '还没有复习记录 —— 记忆留存要练过才能估。',
    };
  }
  return {
    ...base,
    view: hardPointBand(masteryBandIdx(retrievability)),
    note: '会随时间逐渐遗忘；到期时适合复习。',
  };
}

// p(L) 维：直接复用 S1 masteryBandView（真 σ 区间 + low_confidence）。
function buildMasteryDim(mastery: MasteryBandInput | null): NodeDimView {
  const view = mastery == null ? masteryBandUnknown() : masteryBandView(mastery);
  return {
    key: 'pL',
    label: '理解程度',
    labels: A5_BANDS,
    unknownLabel: UNKNOWN_BAND_LABEL,
    view,
    note: '根据你的真实作答逐步校准。',
  };
}

// diff 维：有确凿 hard-track anchor + finite β → 离散 hard 点 band（β 无 CI）；
// 无锚、缺值或非有限值 → 难度未知 + soft + 低置信（under-claim）。
function buildDifficultyDim(beta: number | null, difficultyAnchored: boolean): NodeDimView {
  const base = {
    key: 'diff' as const,
    label: '题目难度',
    labels: DIFFICULTY_BANDS,
    unknownLabel: UNKNOWN_BAND_LABEL,
  };
  if (!difficultyAnchored || beta == null || !Number.isFinite(beta)) {
    return {
      ...base,
      view: masteryBandUnknown(),
      note: '目前还无法稳定判断难度；再练几道后会更明确。',
    };
  }
  return {
    ...base,
    view: hardPointBand(difficultyBandIdx(beta)),
    note: '根据相关题目的难度锚判断。',
  };
}

function buildColdNote(evidenceCount: number): string | null {
  if (evidenceCount >= COLD_NOTE_MAX_EVIDENCE) return null;
  return `这点真实作答还少（${evidenceCount} 次）—— 当前状态主要来自初步判断，还不是稳定结论。先看相对强弱，继续练习后会更可靠。`;
}

/**
 * 把焦点节点的三维 RAW 输入组装成三条正交维度的离散 band 视图 + 冷启告示。
 * 纯函数、零 IO、零写回（三轴正交）。
 */
export function buildNodeThreeDim(input: NodeThreeDimInput): NodeThreeDim {
  const masteryDim = buildMasteryDim(input.mastery);
  return {
    composite: masteryDim.view,
    dims: [
      buildRetentionDim(input.retrievability),
      masteryDim,
      buildDifficultyDim(input.beta, input.difficultyAnchored),
    ],
    coldNote: buildColdNote(input.evidenceCount),
  };
}
