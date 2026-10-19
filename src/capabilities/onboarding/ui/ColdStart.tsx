// Cold-start /today intercept hero (YUK-473 Slice 1, truth contract YUK-621).
// Ported 1:1 from docs/design/loom-refresh/project/screen-onboarding.jsx
// (ColdToday). Rendered by TodayPage only when summary.cold_start.is_empty.
// Design note: prototype uses the legacy <Icon>; the real app standardises on
// <LoomIcon> (same names — see grounding), so we use LoomIcon throughout.

import { BrandMark } from '@/ui/primitives/BrandMark';
import { Btn } from '@/ui/primitives/Btn';
import { LoomIcon, type LoomIconName } from '@/ui/primitives/LoomIcon';
import './onboarding.css';

export interface ColdStartProps {
  navigate: (to: string) => void;
}

const LANES: Array<{ ic: LoomIconName; t: string; s: string }> = [
  { ic: 'target', t: '定下方向', s: '用一句话写下近期目标' },
  { ic: 'layers', t: '带上材料', s: '错题、卷子或课本题都可以' },
  { ic: 'review', t: '开始定位', s: '先用一小组题找到起点' },
];

export default function ColdStart({ navigate }: ColdStartProps) {
  return (
    <div className="page ob-cold">
      <div className="ob-cold-hero ob-rise">
        <div className="ob-cold-mark">
          <BrandMark size={44} />
        </div>
        <h1 className="ob-cold-title serif">先告诉我你想学什么</h1>
        <p className="ob-cold-sub">
          先设一个目标；你也可以带上错题、卷子或课本题，我会从你的材料里准备第一组练习。
        </p>
        <div className="ob-cold-cta">
          <Btn variant="primary" size="lg" iconEnd="arrow" onClick={() => navigate('/welcome')}>
            开始设定 · 约 2 分钟
          </Btn>
        </div>
        <div className="ob-cold-empty">
          <LoomIcon name="moon" size={14} className="ico" />
          当前还没有学习目标或可以继续的学习记录
        </div>
      </div>
      {/* 这些行动提示对屏幕阅读器同样有信息价值，不设 aria-hidden。 */}
      <div className="ob-cold-lanes">
        {LANES.map((l) => (
          <div key={l.t} className="ob-cold-lane">
            <LoomIcon name={l.ic} size={20} className="ico" />
            <div className="ob-cold-lane-t">{l.t}</div>
            <div className="ob-cold-lane-s">{l.s}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
