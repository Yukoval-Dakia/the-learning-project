// Cold-start /today intercept hero (YUK-473 Slice 1, truth contract YUK-621). Rendered by TodayPage
// only when summary.cold_start.is_empty. M3E presentation (YUK-1473): same first-run root as
// /welcome, styles in onboarding-m3e.css, design record docs/design/2026-11-03-last-old-ui-m3e.md.

import { ArrowRight, Layers, type LucideIcon, Moon, RotateCcw, Target } from 'lucide-react';
import { Button, Mascot, UiNextRoot } from '@/ui-next/public';
import './onboarding-m3e.css';

export interface ColdStartProps {
  navigate: (to: string) => void;
}

const LANES: Array<{ ic: LucideIcon; t: string; s: string }> = [
  { ic: Target, t: '定下方向', s: '用一句话写下近期目标' },
  { ic: Layers, t: '带上材料', s: '错题、卷子或课本题都可以' },
  { ic: RotateCcw, t: '开始定位', s: '先用一小组题找到起点' },
];

export default function ColdStart({ navigate }: ColdStartProps) {
  return (
    <UiNextRoot className="un-ob un-ob-cold" data-un-m3e="practice-foundation">
      <main className="un-ob-main un-m3e-bridge">
        <div className="un-ob-cold-hero">
          <Mascot />
          <h1 className="un-ob-cold-title">先告诉我你想学什么</h1>
          <p className="un-ob-cold-sub">
            先设一个目标；你也可以带上错题、卷子或课本题，我会从你的材料里准备第一组练习。
          </p>
          <div className="un-ob-cold-cta">
            <Button
              variant="primary"
              className="un-m3e-control"
              onClick={() => navigate('/welcome')}
            >
              开始设定 · 约 2 分钟
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
          <div className="un-ob-cold-empty">
            <Moon size={16} aria-hidden="true" />
            当前还没有学习目标或可以继续的学习记录
          </div>
        </div>
        {/* 这些行动提示对屏幕阅读器同样有信息价值，不设 aria-hidden。 */}
        <div className="un-ob-cold-lanes">
          {LANES.map((l) => (
            <div key={l.t} className="un-ob-cold-lane">
              <span className="un-ob-cold-lane-ic">
                <l.ic size={20} aria-hidden="true" />
              </span>
              <div className="un-ob-cold-lane-t">{l.t}</div>
              <div className="un-ob-cold-lane-s">{l.s}</div>
            </div>
          ))}
        </div>
      </main>
    </UiNextRoot>
  );
}
