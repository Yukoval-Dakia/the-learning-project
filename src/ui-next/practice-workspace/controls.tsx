import { useId, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Action, Content, Notice, Renderers } from './contracts';

export function Icon({
  name,
}: {
  name: 'sun' | 'moon' | 'partner' | 'quote' | 'close' | 'back' | 'history' | 'send';
}) {
  const paths = {
    sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    moon: 'M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z',
    partner: 'M4 4h16v12H9l-5 4V4Zm4 5h8m-8 3h5',
    quote: 'M5 7h5v6H6l-1 4m9-10h5v6h-4l-1 4',
    close: 'm6 6 12 12M6 18 18 6',
    back: 'm10 5-7 7 7 7M3 12h18',
    history: 'M3 4v5h5M3 9a9 9 0 1 1 0 6m9-8v5l3 2',
    send: 'm3 4 18 8-18 8 3-8-3-8Zm3 8h15',
  };
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  const id = useId();
  const [dismissed, setDismissed] = useState(false);
  return (
    <span
      className="un-pw-tip-host"
      data-dismissed={dismissed}
      onPointerEnter={() => setDismissed(false)}
      onFocus={() => setDismissed(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !dismissed) {
          event.preventDefault();
          event.stopPropagation();
          setDismissed(true);
        }
      }}
    >
      <button
        {...props}
        type="button"
        className="un-pw-icon"
        aria-label={label}
        aria-describedby={id}
      >
        {children}
      </button>
      <span id={id} role="tooltip" className="un-pw-tooltip">
        {label}
      </span>
    </span>
  );
}
export function ActionButton({
  action,
  onAction,
  primary = false,
  icon,
}: {
  action: Action;
  onAction(id: string): void;
  primary?: boolean;
  icon?: ReactNode;
}) {
  const id = useId();
  const unavailable = action.availability.kind !== 'enabled';
  return (
    <span className="un-pw-action-wrap">
      <button
        type="button"
        className={primary ? 'un-pw-action un-pw-primary' : 'un-pw-action'}
        disabled={unavailable}
        aria-busy={action.availability.kind === 'busy'}
        aria-describedby={unavailable ? id : undefined}
        onClick={() => onAction(action.id)}
      >
        {icon}
        {action.label}
        {action.availability.kind === 'busy' && <span aria-hidden="true"> …</span>}
      </button>
      {action.availability.kind !== 'enabled' && (
        <small id={id}>{action.availability.reason}</small>
      )}
    </span>
  );
}
export function Actions({
  items,
  onAction,
}: {
  items: readonly Action[];
  onAction(id: string): void;
}) {
  return (
    <div className="un-pw-actions">
      {items.map((action) => (
        <ActionButton key={action.id} action={action} onAction={onAction} />
      ))}
    </div>
  );
}
export function NoticeView({
  notice,
  onAction,
  strong = false,
}: {
  notice: Notice;
  onAction(id: string): void;
  strong?: boolean;
}) {
  return (
    <div className={strong ? 'un-pw-notice un-pw-attention' : 'un-pw-notice'}>
      <p>
        <strong>{notice.title}</strong>
      </p>
      {notice.detail && <p>{notice.detail}</p>}
      {notice.actions && <Actions items={notice.actions} onAction={onAction} />}
    </div>
  );
}
export function ContentView({
  content,
  renderers,
}: {
  content: Content;
  renderers: Pick<Renderers, 'content'>;
}) {
  return (
    <div className="un-pw-content" role="region" aria-label={content.label} tabIndex={0}>
      {renderers.content(content)}
    </div>
  );
}
