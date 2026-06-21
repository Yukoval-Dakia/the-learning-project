// Cold-start /today intercept hero (YUK-473 Slice 1).
// Ported 1:1 from docs/design/loom-refresh/project/screen-onboarding.jsx
// (ColdToday). Rendered by TodayPage when summary.kpi.goal_count === 0.
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
  { ic: 'review', t: '复习队列', s: 'FSRS 还没有到期项' },
  { ic: 'layers', t: '学习意图', s: '尚未录入学习项' },
  { ic: 'target', t: 'AI Coach', s: '等你先答几题' },
];

export default function ColdStart({ navigate }: ColdStartProps) {
  return (
    <div className="page ob-cold">
      <div className="ob-cold-hero ob-rise">
        <div className="ob-cold-mark">
          <BrandMark size={44} />
        </div>
        <h1 className="ob-cold-title serif">从一张白纸开始</h1>
        <p className="ob-cold-sub">
          你的今日还空着——没有要复习的，也没有题库。 带上你的材料，我先为你备一套个人化的练习。
        </p>
        <div className="ob-cold-cta">
          <Btn variant="primary" size="lg" iconEnd="arrow" onClick={() => navigate('/welcome')}>
            开始设定 · 约 2 分钟
          </Btn>
        </div>
        <div className="ob-cold-empty">
          <LoomIcon name="moon" size={14} className="ico" />
          昨晚没有 Dreaming agent 跑过 · 冷库 goal·learning_item·mastery_state 三表皆空
        </div>
      </div>
      <div className="ob-cold-lanes" aria-hidden="true">
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
