import { ChevronDown } from 'lucide-react';
import { useId } from 'react';
import { Button } from '../primitives/Button';
import type { CauseEditor as CauseEditorModel } from './contracts';
import './cause-editor.css';

const sourceLabel = {
  user: '你自己标的',
  agent: 'AI 判断',
} as const;

/**
 * YUK-2108 learner cause attribution.
 *
 * The wire and eligibility stay with the practice owner. This renderer receives one owner-projected
 * state, keeps choice and note edits local until the owner action is pressed, and renders the
 * owner's receipt or failure notice. It fits both the result card and the 「做错过」 row.
 */
export function CauseEditor({ editor }: { editor: CauseEditorModel }) {
  const name = useId();
  const disabled = editor.mode !== 'editable';
  return (
    <details className="un-cause" onToggle={(event) => editor.onToggle?.(event.currentTarget.open)}>
      <summary>
        <ChevronDown size={18} aria-hidden="true" />
        <span>我觉得是因为……</span>
      </summary>
      <div className="un-cause-body">
        <p className="un-cause-current" aria-live="polite">
          {editor.mode === 'busy' ? (
            '正在读取现在记的原因…'
          ) : editor.current ? (
            <>
              现在记的是：<strong>{editor.current.label}</strong>
              <span> · {sourceLabel[editor.current.source]}</span>
            </>
          ) : editor.notice ? (
            '现在记的原因暂时不确定。'
          ) : (
            '现在还没有记下错因。'
          )}
        </p>
        <fieldset disabled={disabled} aria-busy={editor.mode === 'busy' || undefined}>
          <legend>这次主要是因为</legend>
          <div className="un-cause-options">
            {editor.options.map((option) => (
              <label key={option.id}>
                <input
                  type="radio"
                  name={name}
                  value={option.id}
                  checked={editor.selected === option.id}
                  onChange={() => editor.onSelect(option.id)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <label className="un-cause-note">
            <span>再补一句（选填）</span>
            <textarea
              rows={3}
              value={editor.note}
              onChange={(event) => editor.onNoteChange(event.target.value)}
            />
          </label>
        </fieldset>
        {editor.reason && <p className="un-cause-reason">{editor.reason}</p>}
        {editor.notice && (
          <div
            className="un-cause-notice"
            data-tone={editor.noticeTone ?? (editor.notice.actions?.length ? 'error' : 'status')}
            role={editor.noticeTone === 'error' ? 'alert' : 'status'}
          >
            {editor.notice.title && <p>{editor.notice.title}</p>}
            {editor.notice.detail && <p>{editor.notice.detail}</p>}
            {editor.notice.actions && editor.notice.actions.length > 0 && (
              <div className="un-cause-actions">
                {editor.notice.actions.map((action) => (
                  <Button
                    key={action.id}
                    variant="secondary"
                    size="sm"
                    disabled={action.availability.kind !== 'enabled'}
                    aria-busy={action.availability.kind === 'busy' || undefined}
                    title={
                      action.availability.kind !== 'enabled'
                        ? action.availability.reason
                        : undefined
                    }
                    onClick={() => editor.onAction(action.id)}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
        {editor.actions.length > 0 && (
          <div className="un-cause-actions">
            {editor.actions.map((action, index) => (
              <Button
                key={action.id}
                variant={index === 0 ? 'primary' : 'secondary'}
                disabled={action.availability.kind !== 'enabled'}
                aria-busy={action.availability.kind === 'busy' || undefined}
                title={
                  action.availability.kind !== 'enabled' ? action.availability.reason : undefined
                }
                onClick={() => editor.onAction(action.id)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
