// StatusBadge — FSRS 3-tier + learning session statuses
import type { BadgeTone } from './Badge';
import { Badge } from './Badge';

export type StatusValue =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'extracted'
  | 'partial'
  | 'failed'
  | 'queued'
  | 'extracting'
  // FSRS
  | 'again'
  | 'hard'
  | 'good';

const STATUS_MAP: Record<StatusValue, [BadgeTone, string]> = {
  pending: ['neutral', '待办'],
  in_progress: ['hard', '进行中'],
  done: ['good', '已完成'],
  extracted: ['info', 'extracted'],
  partial: ['hard', 'partial'],
  failed: ['again', 'failed'],
  queued: ['neutral', 'queued'],
  extracting: ['hard', 'extracting'],
  // FSRS tier labels
  again: ['again', '不会'],
  hard: ['hard', '模糊'],
  good: ['good', '会了'],
};

export interface StatusBadgeProps {
  status: StatusValue | string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const entry = STATUS_MAP[status as StatusValue];
  const [tone, label] = entry ?? (['neutral', status] as [BadgeTone, string]);
  return (
    <Badge tone={tone} className={className}>
      {label}
    </Badge>
  );
}
