// Onboarding ③ · placement stub (YUK-473 Slice 1).
// Placeholder so the Welcome fork's secondary route (/placement) does not
// dangle. The next slice replaces this with the real placement loop
// (screen-onboarding.jsx ScreenPlacement). Keep it minimal — no fabricated UI.

import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';

export interface PlacementStubPageProps {
  navigate: (to: string) => void;
}

export default function PlacementStubPage({ navigate }: PlacementStubPageProps) {
  return (
    <div className="page">
      <EmptyState
        icon="clock"
        title="定位练习"
        text="（下一片实现）"
        action={
          <Btn variant="ghost" icon="today" onClick={() => navigate('/today')}>
            返回今日
          </Btn>
        }
      />
    </div>
  );
}
