// An empty area on the knowledge pages (M14): a quiet icon, one line of title, an optional line of
// what to do next. Shared by the tree (no nodes), the detail page (no notes, missing node).
import type { ReactNode } from 'react';

export function KnowledgeEmpty({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text?: string;
}) {
  return (
    <div className="kn-empty">
      <span className="kn-empty-icon" aria-hidden="true">
        {icon}
      </span>
      <p className="kn-empty-title">{title}</p>
      {text && <p className="kn-empty-text">{text}</p>}
    </div>
  );
}
