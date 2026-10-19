import { Fragment } from 'react';

export type ObStepId = 'welcome' | 'source' | 'placement' | 'profile';

const STEPS: Array<{ id: ObStepId; n: string; label: string }> = [
  { id: 'welcome', n: '1', label: '设定' },
  { id: 'source', n: '2', label: '备料' },
  { id: 'placement', n: '3', label: '定位' },
  { id: 'profile', n: '4', label: '档案' },
];
// ORDER is derived from STEPS so a reorder cannot desync the rail.
const ORDER: ObStepId[] = STEPS.map((s) => s.id);

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
