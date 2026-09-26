// YUK-1051 — 槽位状态 badge（六状态各有 submission 锚点，§3/§7.3）。
//
// 色纪律（§6.4）：lifecycle badge 全部是中性/注意级（neutral/info/hard），对错色
// 只在 feedback release 后由 outcome 出现。paper 作答全程只渲 lifecycle，不传
// releasedOutcome —— 「缓冲反馈」由类型层守住。

import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';

import {
  COARSE_OUTCOME_META,
  type CoarseOutcome,
  SUBMISSION_LIFECYCLE_META,
  type SubmissionLifecycle,
} from './response-types';

const LIFECYCLE_ICON: Record<SubmissionLifecycle, LoomIconName> = {
  draft: 'pencil',
  submitted_pending: 'clock',
  group_tentative: 'layers',
  needs_review: 'alert',
  effective: 'check',
  superseded: 'reverse',
};

export interface SlotResultBadgeProps {
  lifecycle: SubmissionLifecycle;
  /** 仅在 lifecycle='effective' 且判定已对用户 release 时传；paper 作答中绝不传。 */
  releasedOutcome?: CoarseOutcome | null;
  /** 锚点摘要（submission/run id 头几位）；悬停可见，证明状态有锚。 */
  anchorTitle?: string;
}

export function SlotResultBadge({ lifecycle, releasedOutcome, anchorTitle }: SlotResultBadgeProps) {
  const meta = SUBMISSION_LIFECYCLE_META[lifecycle];
  // 生效且判定已 release → 展示对错（颜色 = 判定，§6.4 的 release 时刻）。
  if (lifecycle === 'effective' && releasedOutcome) {
    const om = COARSE_OUTCOME_META[releasedOutcome];
    return (
      <span className={`badge tone-${om.tone}`} title={anchorTitle}>
        <LoomIcon
          name={om.tone === 'good' ? 'check' : om.tone === 'again' ? 'close' : 'minus'}
          size={12}
        />
        {om.label}
      </span>
    );
  }
  return (
    <span className={`badge tone-${meta.tone}`} title={anchorTitle}>
      <LoomIcon name={LIFECYCLE_ICON[lifecycle]} size={12} />
      {meta.label}
    </span>
  );
}
