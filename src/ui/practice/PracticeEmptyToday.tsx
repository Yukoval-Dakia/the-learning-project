// PracticeEmptyToday — empty state shown when today has no papers.
// Ported from docs/design/loom-prototype/screen-practice.jsx:101-114.

import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { useRouter } from 'next/navigation';

export function PracticeEmptyToday() {
  const router = useRouter();
  return (
    <LoomCard pad className="paper-empty">
      <EmptyState
        icon="target"
        title="今天还没有成卷"
        text="Coach 会在夜间根据你的薄弱点排出今日卷；也可以现在自己建一张测验。"
        action={
          <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 'var(--s-4)' }}>
            <Btn variant="secondary" icon="clock" onClick={() => router.push('/coach')}>
              看 Coach 排期
            </Btn>
            <Btn variant="primary" icon="plus" onClick={() => router.push('/record')}>
              新建自定义卷
            </Btn>
          </div>
        }
      />
    </LoomCard>
  );
}
