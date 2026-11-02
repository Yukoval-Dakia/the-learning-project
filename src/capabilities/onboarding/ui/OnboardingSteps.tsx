// The first-run step rail in the M3E presentation: 设定 → 备料 → 定位 → 档案. Pages move here from
// the legacy ObSteps as they migrate; ObSteps goes when the last one has (YUK-1473).

import { Check } from 'lucide-react';
import type { ObStepId } from './ObSteps';

const STEPS: ReadonlyArray<{ id: ObStepId; label: string }> = [
  { id: 'welcome', label: '设定' },
  { id: 'source', label: '备料' },
  { id: 'placement', label: '定位' },
  { id: 'profile', label: '档案' },
];

function stepState(index: number, current: number): 'done' | 'current' | 'next' {
  if (index < current) return 'done';
  if (index === current) return 'current';
  return 'next';
}

export function OnboardingSteps({ active }: { active: ObStepId }) {
  const current = STEPS.findIndex((step) => step.id === active);
  return (
    <ol className="un-ob-steps" aria-label="首次使用进度">
      {STEPS.map((step, index) => {
        const state = stepState(index, current);
        return (
          <li
            key={step.id}
            className="un-ob-step"
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="un-ob-step-n" aria-hidden="true">
              {state === 'done' ? <Check size={14} /> : index + 1}
            </span>
            {step.label}
            {state === 'done' && <span className="un-sr-only">（已完成）</span>}
          </li>
        );
      })}
    </ol>
  );
}
