import { useId } from 'react';
import type { AnswerField, PracticeIntents, PracticeRenderers } from './contracts';
import { Actions } from './controls';

export function AnswerControl({
  field: f,
  intents,
  renderers,
}: {
  field: AnswerField;
  intents: PracticeIntents;
  renderers: PracticeRenderers;
}) {
  const id = useId();
  const help = `${id}-help`;
  const locked = f.mode !== 'editable';
  const shared = {
    id,
    'aria-describedby': help,
    'aria-invalid': !!f.error,
    'aria-busy': f.mode === 'busy',
    disabled: f.mode === 'disabled' || f.mode === 'busy',
    readOnly: f.mode === 'readonly',
  };
  return (
    <fieldset className="un-pw-field" data-mode={f.mode} aria-busy={f.mode === 'busy'}>
      <legend>{f.label}</legend>
      {(f.kind === 'single' || f.kind === 'multiple') && (
        <div className="un-pw-options">
          {f.options.map((o) => (
            <label key={o.id} className="un-pw-option" data-selected={f.selected.includes(o.id)}>
              <input
                type={f.kind === 'single' ? 'radio' : 'checkbox'}
                name={id}
                checked={f.selected.includes(o.id)}
                disabled={locked}
                aria-describedby={help}
                aria-invalid={!!f.error}
                onChange={(e) =>
                  intents.answer(
                    f.id,
                    f.kind === 'single'
                      ? [o.id]
                      : e.target.checked
                        ? [...f.selected, o.id]
                        : f.selected.filter((x) => x !== o.id),
                  )
                }
              />
              <span className="un-pw-option-key">{o.key}</span>
              <span className="un-pw-option-body">{renderers.content(o.content)}</span>
            </label>
          ))}
        </div>
      )}
      {(f.kind === 'text' || f.kind === 'formula') && (
        <textarea
          {...shared}
          aria-label={f.label}
          rows={f.kind === 'text' ? 5 : 2}
          value={f.value}
          onChange={(e) => intents.answer(f.id, e.target.value)}
        />
      )}
      {f.kind === 'number' && (
        <input
          {...shared}
          aria-label={f.label}
          type="text"
          inputMode="decimal"
          value={f.value}
          onChange={(e) => intents.answer(f.id, e.target.value)}
        />
      )}
      {f.kind === 'attachments' && (
        <>
          <label className="un-pw-upload">
            添加附件
            <input
              aria-describedby={help}
              type="file"
              accept={f.accept}
              multiple={f.multiple}
              disabled={locked}
              onChange={(e) => {
                if (e.target.files) intents.attach(f.id, Array.from(e.target.files));
                e.target.value = '';
              }}
            />
          </label>
          <ul className="un-pw-list">
            {f.items.map((a) => (
              <li key={a.id}>
                <strong>{a.name}</strong>
                {a.state.kind === 'uploading' ? (
                  <>
                    <span>上传中</span>
                    <progress aria-label={`${a.name}上传进度`} max={100} value={a.state.progress} />
                  </>
                ) : (
                  <p>{a.state.kind === 'complete' ? '上传完成' : a.state.detail}</p>
                )}
                <Actions items={a.actions} onAction={intents.action} />
              </li>
            ))}
          </ul>
        </>
      )}
      {f.kind === 'specialized' &&
        (f.safety.kind === 'approved' ? (
          renderers.answer({
            id: f.controlId,
            accessibleName: f.label,
            boundaryId: f.safety.boundaryId,
            mode: f.mode,
            reason: f.reason,
            describedBy: help,
            invalid: !!f.error,
            onIntent: (payload) => {
              if (!locked) intents.specializedAnswer(f.id, payload);
            },
          })
        ) : (
          <p>{f.safety.reason}</p>
        ))}
      {f.kind === 'withheld' && <p>{f.reason}</p>}
      <div id={help} className="un-pw-field-help">
        {f.hint && <p>{f.hint}</p>}
        {f.reason && <p>{f.reason}</p>}
        {f.mode === 'readonly' && <p>仅查看原作答</p>}
        {f.error && <p className="un-pw-error">{f.error}</p>}
      </div>
    </fieldset>
  );
}
