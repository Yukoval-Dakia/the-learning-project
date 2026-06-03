// EmptyState — centered icon/title/text empty placeholder with optional future
// tag + action slot. className-driven over the .empty class layer in
// app/globals.css. Ported from docs/design/loom-prototype/components.jsx
// (EmptyState); prototype's `future` prop is exposed here as `futureTag` per spec.

import type { ReactNode } from 'react';
import { LoomIcon } from './LoomIcon';
import type { LoomIconName } from './LoomIcon';

export interface EmptyStateProps {
  icon?: LoomIconName;
  title?: ReactNode;
  text?: ReactNode;
  futureTag?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon = 'sparkle', title, text, futureTag, action }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty-ico">
        <LoomIcon name={icon} size={24} />
      </div>
      <div className="empty-title serif">{title}</div>
      <div className="empty-text">{text}</div>
      {futureTag && <span className="future-tag">{futureTag}</span>}
      {action}
    </div>
  );
}
