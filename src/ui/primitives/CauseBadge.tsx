// CauseBadge — derived from a `judge` event payload (cause object)
// Brief voice rule: surface AI vs user, plus confidence.
// Matches loom-design-v2 CauseBadge, adapted per ADR-0006 v2.

import { Badge } from './Badge';

export type CauseActorKind = 'user' | 'agent' | 'cron' | 'system';

export type CausePrimary =
  | 'concept'
  | 'knowledge_gap'
  | 'calculation'
  | 'reading_comprehension'
  | 'careless_mistake'
  | 'memory_lapse'
  | 'grammar'
  | 'vocabulary'
  | 'logic'
  | 'other';

export interface Cause {
  actor_kind: CauseActorKind;
  primary: CausePrimary | string;
  /**
   * YUK-1018 — display backfill for `misc_` primary ids (active misconception
   * title resolved server-side). Renders in place of `primary` when present;
   * `primary` stays the stable identity for analytics/dedup.
   */
  primary_label?: string | null;
  /** Phase 1c.2: secondary categories surfaced when the agent judge attached them. */
  secondary?: string[] | null;
  /**
   * YUK-1020 — display backfill for `misc_` ids inside `secondary` (id → active
   * misconception title map resolved server-side). Each chip renders
   * `secondary_labels[id] ?? id`; `secondary` stays the stable identity for
   * analytics/dedup.
   */
  secondary_labels?: Record<string, string> | null;
  confidence?: number | null;
  ai_analysis_md?: string;
}

export interface CauseBadgeProps {
  cause?: Cause | null;
  /** Elapsed seconds since attribution started (for pending state) */
  pendingSinceSec?: number;
  className?: string;
}

export function CauseBadge({ cause, pendingSinceSec, className }: CauseBadgeProps) {
  if (!cause) {
    const elapsed = pendingSinceSec ?? 0;
    if (elapsed < 30) {
      return (
        <Badge tone="hard" dot className={className}>
          归因中...
        </Badge>
      );
    }
    return (
      <Badge tone="neutral" className={className}>
        待归因
      </Badge>
    );
  }

  const isAi = cause.actor_kind === 'agent';
  const tone = isAi ? 'info' : 'good';
  const conf = cause.confidence != null ? ` (${Math.round(cause.confidence * 100)}%)` : '';
  // YUK-1018 — misc_ id 显示 misconception title；非 misc / unresolvable 回退裸 id。
  const primaryText = cause.primary_label ?? cause.primary;
  const label = isAi ? `AI · ${primaryText}${conf}` : `用户 · ${primaryText}`;
  const secondary = (cause.secondary ?? []).filter((s) => s && s !== cause.primary);

  if (secondary.length === 0) {
    return (
      <Badge tone={tone} className={className}>
        {label}
      </Badge>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      <Badge tone={tone} className={className}>
        {label}
      </Badge>
      {secondary.map((s) => (
        <Badge key={s} tone="neutral">
          +{cause.secondary_labels?.[s] ?? s}
        </Badge>
      ))}
    </span>
  );
}
