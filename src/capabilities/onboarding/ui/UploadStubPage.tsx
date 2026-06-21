// Onboarding ②a · upload stub (YUK-473 Slice 1).
// Placeholder so the Welcome fork's primary route (/onboarding/upload) does not
// dangle. The next slice replaces this with the real record/ingestion cold-wrap
// (screen-onboarding.jsx OnboardRecord). Keep it minimal — no fabricated UI.

import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';

export interface UploadStubPageProps {
  navigate: (to: string) => void;
}

export default function UploadStubPage({ navigate }: UploadStubPageProps) {
  return (
    <div className="page">
      <EmptyState
        icon="clock"
        title="上传我的材料"
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
