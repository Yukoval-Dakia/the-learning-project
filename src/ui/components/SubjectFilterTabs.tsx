import { type SubjectRowLike, listSubjectChoices } from '@/ui/lib/subject';

export interface SubjectFilterTabsProps {
  readonly value: string;
  readonly rows?: readonly SubjectRowLike[];
  readonly onChange: (value: string) => void;
}

export function SubjectFilterTabs({ value, rows, onChange }: SubjectFilterTabsProps) {
  const options = listSubjectChoices(rows);
  return (
    <fieldset className="subject-filter-row">
      <legend className="filter-row-l">科目</legend>
      <button
        type="button"
        className={`chip${value === 'all' ? ' is-on' : ''}`}
        aria-pressed={value === 'all'}
        onClick={() => onChange('all')}
      >
        全部
      </button>
      {options.map((option) => (
        <button
          type="button"
          key={option.id}
          className={`chip${value === option.id ? ' is-on' : ''}`}
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
