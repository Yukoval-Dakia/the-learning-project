import type { ReactNode } from 'react';

export interface CompanionPanelProps {
  open: boolean;
  /** Accessible name of the panel, e.g. "学习伙伴". */
  label: string;
  header: ReactNode;
  children: ReactNode;
}

/**
 * The companion's place beside the content (C1). Collapsed, it is inert: nothing inside can be
 * focused or announced (A1). What goes inside (messages, composer) belongs to the companion wave.
 */
export function CompanionPanel({ open, label, header, children }: CompanionPanelProps) {
  return (
    <aside className="un-companion" data-open={open} aria-label={label} inert={!open}>
      <div className="un-companion-head">{header}</div>
      <div className="un-companion-body">{children}</div>
    </aside>
  );
}
