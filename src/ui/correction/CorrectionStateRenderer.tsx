import Link from 'next/link';
import React from 'react';

import { Badge, type BadgeTone } from '@/ui/primitives/Badge';

export type CorrectionStateName =
  | 'active'
  | 'retracted'
  | 'marked_wrong'
  | 'superseded'
  | 'missing'
  | 'cycle';

export interface CorrectionStateSnapshot {
  state: CorrectionStateName;
  terminal_state?: CorrectionStateName;
  effective_event_id?: string | null;
  correction_event_id?: string | null;
  replacement_event_id?: string | null;
}

interface CorrectionStateRendererProps {
  state: CorrectionStateSnapshot | null | undefined;
  showActive?: boolean;
  compact?: boolean;
}

const LABELS: Record<CorrectionStateName, string> = {
  active: 'active',
  retracted: '已撤回',
  marked_wrong: '已标错',
  superseded: '已替换',
  missing: '替换缺失',
  cycle: '替换循环',
};

function toneForState(state: CorrectionStateName): BadgeTone {
  if (state === 'active') return 'good';
  if (state === 'superseded') return 'hard';
  if (state === 'missing' || state === 'cycle') return 'info';
  return 'again';
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}...`;
}

export function CorrectionStateRenderer({
  state,
  showActive = false,
  compact = false,
}: CorrectionStateRendererProps) {
  if (!state) return null;
  const displayState = state.state;
  if (displayState === 'active' && !showActive) return null;

  const replacementId = state.effective_event_id ?? state.replacement_event_id ?? null;

  return React.createElement(
    'span',
    { style: compact ? compactWrapStyle : wrapStyle },
    React.createElement(Badge, { tone: toneForState(displayState) }, LABELS[displayState]),
    replacementId && replacementId !== state.correction_event_id
      ? React.createElement(
          Link,
          { href: `/events/${replacementId}`, style: linkStyle },
          shortId(replacementId),
        )
      : null,
    state.correction_event_id
      ? React.createElement(
          Link,
          { href: `/events/${state.correction_event_id}`, style: linkStyle },
          'correct ',
          shortId(state.correction_event_id),
        )
      : null,
  );
}

const wrapStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  minWidth: 0,
};

const compactWrapStyle: React.CSSProperties = {
  ...wrapStyle,
  gap: 4,
};

const linkStyle: React.CSSProperties = {
  color: 'var(--coral)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  textDecoration: 'none',
};
