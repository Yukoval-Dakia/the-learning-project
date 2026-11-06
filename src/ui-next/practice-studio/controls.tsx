import { ArrowLeft, ArrowRight, CircleAlert, Lightbulb, Quote } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Action, Confidence, Notice, PracticeIntents } from './contracts';

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

export function ConfidenceScale({
  confidence: c,
  intents,
}: {
  confidence: Confidence;
  intents: PracticeIntents;
}) {
  return (
    <fieldset className="un-st-answer-confidence" disabled={c.availability.kind !== 'enabled'}>
      <legend>这题你有多大把握？（选填）</legend>
      <div className="un-st-confidence-scale">
        {([1, 2, 3, 4, 5] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={c.value === value}
            onClick={() => intents.confidence(value)}
          >
            <strong>{value}</strong>
            <span className="un-st-confidence-caption">
              {value === 1 ? '没把握' : value === 3 ? '有些把握' : value === 5 ? '很有把握' : ' '}
            </span>
          </button>
        ))}
      </div>
    </fieldset>
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
      {notice.title && (
        <p className="un-st-notice-title">
          {tone === 'error' && <CircleAlert size={15} aria-hidden="true" />}
          {notice.title}
        </p>
      )}
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
