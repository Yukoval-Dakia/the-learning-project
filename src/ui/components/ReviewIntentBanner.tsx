'use client';

import { Button } from '@/ui/primitives/Button';
import { Icon } from '@/ui/primitives/Icon';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface ReviewIntentBannerProps {
  intent: string;
  updatedAtMs: number;
  nowMs?: number;
  refreshing?: boolean;
  onDismiss: () => void;
  onRefresh: () => void;
}

export function ReviewIntentBanner({
  intent,
  updatedAtMs,
  nowMs = Date.now(),
  refreshing = false,
  onDismiss,
  onRefresh,
}: ReviewIntentBannerProps) {
  const isStale = nowMs - updatedAtMs > STALE_AFTER_MS;

  return (
    <div className="review-intent" aria-label="session intent">
      <div className="review-intent-copy">
        <span>{intent}</span>
        {isStale && <span className="review-intent-stale">已超过 24h</span>}
      </div>
      <div className="review-intent-actions">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="刷新 session intent"
          title="刷新 session intent"
        >
          <Icon name="refresh" size={15} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label="隐藏 session intent"
          title="隐藏 session intent"
        >
          <Icon name="x" size={15} />
        </Button>
      </div>
    </div>
  );
}
