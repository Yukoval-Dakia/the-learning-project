// YUK-1438 — optional "which subject is this material?" choice on the upload screens.
// The chosen id rides the ingestion-session create request as `subject_id` (YUK-1404),
// so draft questions can render their subject's notation (e.g. math formulas) before
// anything is enrolled. Skippable: no choice sends nothing and the upload is unchanged.
import { useSubjects } from '@/ui/hooks/useSubjects';
import { listSubjectChoices } from '@/ui/lib/subject';

export function UploadSubjectPicker({
  value,
  onChange,
  disabled = false,
  docxSelected = false,
}: {
  value: string | null;
  onChange: (subjectId: string | null) => void;
  disabled?: boolean;
  /** Word documents go through a separate upload that does not record the subject yet. */
  docxSelected?: boolean;
}) {
  const { subjects } = useSubjects();
  const choices = listSubjectChoices(subjects);
  return (
    <div className="upload-subject">
      <span className="field-label">这份材料是哪一科？（可不选）</span>
      <div className="chip-set">
        {choices.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`chip${value === s.id ? ' is-on' : ''}`}
            aria-pressed={value === s.id}
            disabled={disabled || docxSelected}
            onClick={() => onChange(value === s.id ? null : s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {docxSelected && (
        <span className="upload-subject-note">
          Word 文档暂时记不下科目，公式会先按普通文字显示。
        </span>
      )}
    </div>
  );
}

/** The `subject_id` part of the create body: only a real choice, never an empty string. */
export function uploadSubjectField(subjectId: string | null): { subject_id?: string } {
  return subjectId ? { subject_id: subjectId } : {};
}
