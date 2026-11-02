import { ArrowLeft, ArrowRight, Lightbulb, Quote } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Action, Notice, PracticeIntents } from './contracts';

export function ToolButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button type="button" className="un-st-icon" aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

export function IntentButton({
  action,
  intents,
  primary = false,
}: {
  action: Action;
  intents: PracticeIntents;
  primary?: boolean;
}) {
  const disabled = action.availability.kind !== 'enabled';
  const Icon =
    action.icon === 'back'
      ? ArrowLeft
      : action.icon === 'quote'
        ? Quote
        : action.icon === 'hint'
          ? Lightbulb
          : primary
            ? ArrowRight
            : null;
  return (
    <button
      type="button"
      className={primary ? 'un-st-button un-st-primary' : 'un-st-button un-st-text'}
      disabled={disabled}
      aria-busy={action.availability.kind === 'busy' || undefined}
      title={action.availability.kind !== 'enabled' ? action.availability.reason : undefined}
      onClick={() => intents.action(action.id)}
    >
      {Icon && <Icon size={20} aria-hidden="true" />}
      <span>{action.label}</span>
    </button>
  );
}

export function NoticeBlock({
  notice,
  intents,
  tone = 'neutral',
}: {
  notice: Notice;
  intents: PracticeIntents;
  tone?: 'neutral' | 'error';
}) {
  return (
    <div className="un-st-notice" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      {notice.title && <p>{notice.title}</p>}
      {notice.detail && <p className="un-st-secondary">{notice.detail}</p>}
      {!!notice.actions?.length && (
        <div className="un-st-actions">
          {notice.actions.map((action) => (
            <IntentButton key={action.id} action={action} intents={intents} />
          ))}
        </div>
      )}
    </div>
  );
}
