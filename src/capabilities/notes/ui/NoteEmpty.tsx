// An empty area on the notes pages (M14): a quiet icon, one line of title, one line of what to
// do next, and an optional way out. Shared by the list (no matches) and the reader (no note).
import type { ReactNode } from 'react';

export function NoteEmpty({
  icon,
  title,
  text,
  action,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="nt-empty">
      <span className="nt-empty-icon" aria-hidden="true">
        {icon}
      </span>
      <p className="nt-empty-title">{title}</p>
      <p className="nt-empty-text">{text}</p>
      {action && <div className="nt-empty-action">{action}</div>}
    </div>
  );
}
