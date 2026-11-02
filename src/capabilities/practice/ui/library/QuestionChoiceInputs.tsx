const LETTERS = 'ABCDEFGHIJ';

/** One box per option, so an option that spans several lines stays one option. */
export function ChoiceInputs({
  choices,
  onChange,
}: {
  choices: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const letter = (index: number) => LETTERS[index] ?? String(index + 1);
  return (
    <fieldset className="qd-field qd-choice-edit">
      <legend className="qd-field-label">选项</legend>
      <ol className="qd-choice-inputs">
        {choices.map((choice, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: options are positional; text can repeat.
          <li key={index} className="qd-choice-input">
            <span className="qd-choice-letter" aria-hidden="true">
              {letter(index)}
            </span>
            <textarea
              className="qd-input qd-textarea"
              rows={Math.min(4, Math.max(1, choice.split('\n').length))}
              value={choice}
              aria-label={`选项 ${letter(index)}`}
              onChange={(e) => {
                const value = e.currentTarget.value;
                onChange(choices.map((c, i) => (i === index ? value : c)));
              }}
            />
            <button
              type="button"
              className="ql-text-btn un-hit"
              aria-label={`去掉选项 ${letter(index)}`}
              onClick={() => onChange(choices.filter((_, i) => i !== index))}
            >
              去掉
            </button>
          </li>
        ))}
      </ol>
      {choices.length < LETTERS.length && (
        <button
          type="button"
          className="ql-text-btn un-hit qd-choice-add"
          onClick={() => onChange([...choices, ''])}
        >
          加一个选项
        </button>
      )}
    </fieldset>
  );
}
