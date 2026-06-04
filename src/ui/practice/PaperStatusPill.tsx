// PaperStatusPill — four-state pill for a paper card.
// Ported from docs/design/loom-prototype/screen-practice.jsx:5-11.
// State derivation:
//   generation_status !== 'ready'           → 生成中
//   session.status === 'in_progress'        → 进行中
//   session.status === 'completed'          → 已完成
//   else (null session or not_started/…)   → 未开始
//
// Note: mock data used `type='paper'` sessions — all session.type here is
// 'review' (RL1, U5 plan §5.1). No `type='paper'` string ships anywhere.

import { LoomIcon } from '@/ui/primitives/LoomIcon';

export interface PaperStatusPillProps {
  generationStatus: string;
  sessionStatus: string | null | undefined;
}

export function PaperStatusPill({ generationStatus, sessionStatus }: PaperStatusPillProps) {
  if (generationStatus === 'failed') {
    return (
      <span className="badge tone-coral">
        <LoomIcon name="alert" size={12} />
        生成失败
      </span>
    );
  }
  if (generationStatus !== 'ready') {
    return (
      <span className="badge tone-info">
        <span className="dot pulse" />
        生成中
      </span>
    );
  }
  if (sessionStatus === 'in_progress' || sessionStatus === 'started') {
    return (
      <span className="badge tone-coral">
        <span className="dot pulse" />
        进行中
      </span>
    );
  }
  if (sessionStatus === 'completed') {
    return (
      <span className="badge tone-good">
        <LoomIcon name="check" size={12} />
        已完成
      </span>
    );
  }
  return <span className="badge tone-neutral">未开始</span>;
}
