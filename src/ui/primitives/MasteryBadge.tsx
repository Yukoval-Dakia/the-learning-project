import { Icon } from './Icon';

export interface MasteryData {
  mastery: number | null;
  evidence_count: number;
  last_evidence_at: number | string | Date | null;
}

export interface MasteryBadgeProps {
  data?: MasteryData | null;
  display?: 'compact' | 'full';
}

function toMillis(value: MasteryData['last_evidence_at']): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function MasteryBadge({ data, display = 'full' }: MasteryBadgeProps) {
  if (!data || data.evidence_count === 0) {
    return (
      <span
        className="mastery mastery-untrained"
        title="evidence_count=0 · 尚无 attempt / review event"
      >
        <Icon name="brain" size={11} />
        未练习
      </span>
    );
  }

  if (data.evidence_count < 3) {
    return (
      <span className="mastery mastery-low-evidence" title="evidence_count<3 · 暂不展示稳定掌握度">
        <Icon name="brain" size={11} />
        证据不足 · n={data.evidence_count}
      </span>
    );
  }

  const mastery = Math.max(0, Math.min(1, data.mastery ?? 0.5));
  const tone = mastery >= 0.7 ? 'good' : mastery >= 0.4 ? 'mid' : 'weak';
  const lastEvidenceMs = toMillis(data.last_evidence_at);
  const ageDays =
    lastEvidenceMs === null
      ? null
      : Math.max(0, Math.floor((Date.now() - lastEvidenceMs) / 86_400_000));
  const decay =
    ageDays !== null && ageDays >= 30
      ? { label: `淡出 ${ageDays}d`, className: 'mastery-decay' }
      : ageDays !== null && ageDays >= 7
        ? { label: `${ageDays}d 未触及`, className: 'mastery-decay mild' }
        : null;

  return (
    <span className={`mastery mastery-${tone}`} title={`evidence_count=${data.evidence_count}`}>
      <span className="mastery-bar">
        <span className="mastery-fill" style={{ width: `${Math.round(mastery * 100)}%` }} />
      </span>
      <span className="mastery-num">{Math.round(mastery * 100)}</span>
      {display === 'full' && <span className="mastery-meta">n={data.evidence_count}</span>}
      {display === 'full' && decay && <span className={decay.className}>{decay.label}</span>}
    </span>
  );
}
