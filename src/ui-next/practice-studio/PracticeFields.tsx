import { Paperclip } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import type { AnswerField, PracticeIntents, PracticeRenderers } from './contracts';
import { IntentButton } from './controls';

export function PracticeField({
  field: f,
  intents,
  renderers,
}: {
  field: AnswerField;
  intents: PracticeIntents;
  renderers: PracticeRenderers;
}) {
  const id = useId();
  const description = `${id}-description`;
  const disabled = f.mode !== 'editable';
  let input: ReactNode;
  if (f.kind === 'specialized') {
    input =
      f.safety.kind === 'withheld' ? (
        <p role="status">{f.safety.reason}</p>
      ) : (
        renderers.answer({
          id: f.controlId,
          accessibleName: f.label,
          boundaryId: f.safety.boundaryId,
          mode: f.mode,
          reason: f.reason,
          describedBy: description,
          invalid: !!f.error,
          onIntent: (payload) => intents.specializedAnswer(f.id, payload),
        })
      );
  } else if (f.kind === 'withheld') {
    input = <p role="status">{f.reason}</p>;
  } else if (f.kind === 'single' || f.kind === 'multiple') {
    input = (
      <fieldset className="un-st-choice-fields" disabled={disabled}>
        <legend>{f.label}</legend>
        {f.options.map((option) => (
          <label key={option.id} className="un-st-choice">
            <input
              type={f.kind === 'single' ? 'radio' : 'checkbox'}
              name={id}
              checked={f.selected.includes(option.id)}
              onChange={() =>
                intents.answer(
                  f.id,
                  f.kind === 'single'
                    ? [option.id]
                    : f.selected.includes(option.id)
                      ? f.selected.filter((value) => value !== option.id)
                      : [...f.selected, option.id],
                )
              }
            />
            <span className="un-st-choice-key" aria-hidden="true">
              {option.key}
            </span>
            <span>{renderers.content(option.content)}</span>
          </label>
        ))}
      </fieldset>
    );
  } else if (f.kind === 'attachments') {
    input = (
      <>
        <label className="un-st-file">
          <Paperclip size={18} />
          {f.label}
          <input
            type="file"
            accept={f.accept}
            multiple={f.multiple}
            disabled={disabled}
            onChange={(event) => {
              if (event.target.files) intents.attach(f.id, Array.from(event.target.files));
            }}
          />
        </label>
        <ul>
          {f.items.map((item) => (
            <li key={item.id}>
              <span>{item.name}</span>
              <span>
                {item.state.kind === 'complete'
                  ? '已上传'
                  : item.state.kind === 'failed'
                    ? item.state.detail
                    : '上传中'}
              </span>
              {item.actions.map((action) => (
                <IntentButton key={action.id} action={action} intents={intents} />
              ))}
            </li>
          ))}
        </ul>
      </>
    );
  } else if (f.kind === 'text' || f.kind === 'formula' || f.kind === 'number') {
    input = (
      <label className="un-st-field-label">
        {f.label}
        <textarea
          rows={f.kind === 'text' ? 4 : 2}
          value={f.value}
          readOnly={f.mode === 'readonly'}
          disabled={f.mode === 'disabled' || f.mode === 'busy'}
          inputMode={f.kind === 'number' ? 'decimal' : undefined}
          aria-describedby={description}
          aria-invalid={!!f.error}
          onChange={(event) => intents.answer(f.id, event.target.value)}
        />
      </label>
    );
  }
  return (
    <div className="un-st-answer-field" data-field={f.id}>
      {input}
      <div id={description}>
        {f.hint && <p className="un-st-secondary">{f.hint}</p>}
        {f.reason && <p className="un-st-secondary">{f.reason}</p>}
        {f.error && <p role="alert">{f.error}</p>}
      </div>
    </div>
  );
}
