// Onboarding shared step rail (YUK-473 Slice 1).
// Ported 1:1 from docs/design/loom-refresh/project/screen-onboarding.jsx
// (ObSteps). The four-step flow: 设定 → 备料 → 定位 → 档案. Slice 1 only renders
// the active="welcome" state; later slices reuse this rail for their steps.

import { Fragment } from 'react';

export type ObStepId = 'welcome' | 'source' | 'placement' | 'profile';

const STEPS: Array<{ id: ObStepId; n: string; label: string }> = [
  { id: 'welcome', n: '1', label: '设定' },
  { id: 'source', n: '2', label: '备料' },
  { id: 'placement', n: '3', label: '定位' },
  { id: 'profile', n: '4', label: '档案' },
];
// OCR #551: derive ORDER from STEPS so there's a single source of truth (reordering
// STEPS can't silently desync the rail).
const ORDER: ObStepId[] = STEPS.map((s) => s.id);

// OCR #551: extracted from a nested ternary (banned by the review checklist).
function stepCls(si: number, ai: number): string {
  if (si === ai) return 'is-on';
  if (si < ai) return 'is-done';
  return '';
}

export interface ObStepsProps {
  active: ObStepId;
}

export function ObSteps({ active }: ObStepsProps) {
  const ai = ORDER.indexOf(active);
  return (
    <div className="ob-steps" aria-label="首会流进度">
      {STEPS.map((s, i) => {
        const si = ORDER.indexOf(s.id);
        const cls = stepCls(si, ai);
        return (
          <Fragment key={s.id}>
            {i > 0 && <span className="ob-step-sep" />}
            <span className={`ob-step ${cls}`}>
              <span className="ob-step-n">{si < ai ? '✓' : s.n}</span>
              {s.label}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
