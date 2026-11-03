// YUK-1051 — 槽位状态 badge（六状态各有 submission 锚点，§3/§7.3）。
//
// 色纪律（§6.4）：lifecycle badge 全部是中性/注意级（neutral/info/hard），对错色
// 只在 feedback release 后由 outcome 出现。paper 作答全程只渲 lifecycle，不传
// releasedOutcome —— 「缓冲反馈」由类型层守住。

import {
  Check,
  CircleAlert,
  Clock,
  Layers,
  type LucideIcon,
  Minus,
  Pencil,
  Undo2,
  X,
} from 'lucide-react';
import type { JudgeResultV2T } from '@/core/schema/capability';

import {
  COARSE_OUTCOME_META,
  type CoarseOutcome,
  SUBMISSION_LIFECYCLE_META,
  type SubmissionLifecycle,
} from './response-types';

const LIFECYCLE_ICON: Record<SubmissionLifecycle, LucideIcon> = {
  draft: Pencil,
  submitted_pending: Clock,
  group_tentative: Layers,
  needs_review: CircleAlert,
  effective: Check,
  superseded: Undo2,
};

export interface SlotResultBadgeProps {
  lifecycle: SubmissionLifecycle;
  /** 仅在 lifecycle='effective' 且判定已对用户 release 时传；paper 作答中绝不传。 */
  releasedOutcome?: CoarseOutcome | null;
  partialUnits?: Extract<JudgeResultV2T, { coarse_outcome: 'partial_unknown' }>['partial_units'];
  /** 锚点摘要（submission/run id 头几位）；悬停可见，证明状态有锚。 */
  anchorTitle?: string;
}

export function SlotResultBadge({
  lifecycle,
  releasedOutcome,
  partialUnits,
  anchorTitle,
}: SlotResultBadgeProps) {
  const meta = SUBMISSION_LIFECYCLE_META[lifecycle];
  // 生效且判定已 release → 展示对错（颜色 = 判定，§6.4 的 release 时刻）。
  if (lifecycle === 'effective' && releasedOutcome) {
    const om = COARSE_OUTCOME_META[releasedOutcome];
    return (
      <span className="rs-badge" data-tone={om.tone} title={anchorTitle}>
        {om.tone === 'good' ? (
          <Check size={14} aria-hidden="true" />
        ) : om.tone === 'again' ? (
          <X size={14} aria-hidden="true" />
        ) : (
          <Minus size={14} aria-hidden="true" />
        )}
        {releasedOutcome === 'partial_unknown' && partialUnits?.length
          ? `部分正确（${partialUnits
              .map((unit) => `${unit.correct_count}/${unit.total_count}`)
              .join('、')}），分数未知`
          : om.label}
      </span>
    );
  }
  const LifecycleIcon = LIFECYCLE_ICON[lifecycle];
  return (
    <span className="rs-badge" data-tone={meta.tone} title={anchorTitle}>
      <LifecycleIcon size={14} aria-hidden="true" />
      {meta.label}
    </span>
  );
}
