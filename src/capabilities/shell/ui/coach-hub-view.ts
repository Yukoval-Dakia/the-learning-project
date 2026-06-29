// YUK-523 — Coach 复盘中枢三视图段切容器的纯配置（tab 列表 / 视图标识 / 默认视图 / eyebrow query）。
// 纯数据，零 React、零 DB → unit 车道。视图 lede 含 JSX，留在 CoachHub.tsx。
//
// 三个正交视图（同屏段切、绝不合并）：
//   ① activity    — FSRS 复习活动报表（现有，逻辑零改）。答「练了多少、对了几道」。
//   ② calibration — 横截面 θ̂/p(L) 点估计 + 置信（复用 calibration-maturity 读模型）。答「现在多准」。
//   ③ efficacy    — 纵向 delta、相对自己的轨迹（EffectivenessTrendPanel）。答「相比上次涨了吗」。
// 校准诊断（横截面「多准」）⟂ 成效趋势（纵向「涨没涨」）：正交、同屏并列。
//
// 逐字 PORT 自设计 docs/design/loom-refresh/project/screen-coach-hub.jsx 的
// COACH_VIEWS / VIEW_QUERY / 默认视图（useState("efficacy")）。

import type { LoomIconName } from '@/ui/primitives/LoomIcon';

export type CoachView = 'activity' | 'calibration' | 'efficacy';

// 默认视图 = 成效趋势（设计 screen-coach-hub.jsx：useState("efficacy")）。
export const DEFAULT_COACH_VIEW: CoachView = 'efficacy';

export interface CoachViewTab {
  id: CoachView;
  label: string;
  icon: LoomIconName;
  /** 「正交」对（calibration 横截面 ⟂ efficacy 纵向）；activity 不参与正交叙事。 */
  ortho: boolean;
}

export const COACH_VIEWS: readonly CoachViewTab[] = [
  { id: 'activity', label: '活动量', icon: 'review', ortho: false },
  { id: 'calibration', label: '校准诊断', icon: 'target', ortho: true },
  { id: 'efficacy', label: '成效趋势', icon: 'history', ortho: true },
];

// eyebrow 尾串（COACH · 复盘中枢 · <这串>）。设计 mock 的端点串替换成真实读模型端点。
export const VIEW_QUERY: Record<CoachView, string> = {
  activity: '活动量 · GET /api/review/weekly · 7/30/90d',
  calibration: '校准诊断 · GET /api/observability/calibration-maturity · adr-0035',
  efficacy: '成效趋势 · GET /api/observability/effectiveness-trend · 纵向 delta',
};

export function isCoachView(v: string | null | undefined): v is CoachView {
  return v === 'activity' || v === 'calibration' || v === 'efficacy';
}
