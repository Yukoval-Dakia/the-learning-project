// YUK-1438 — optional "which subject is this material?" choice on the upload screens.
// The chosen id rides the ingestion-session create request as `subject_id` (YUK-1404),
// so draft questions can render their subject's notation (e.g. math formulas) before
// anything is enrolled. Skippable: no choice sends nothing and the upload is unchanged.
import { useEffect } from 'react';
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
  // Unconfigured rows are raw knowledge domains with no subject profile; the server rejects
  // them as subject_id (400), which would fail an otherwise valid upload.
  const choices = listSubjectChoices(subjects).filter(
    (s) => s.configurationStatus !== 'unconfigured',
  );
  // A choice made on the first-frame builtin list may vanish when the real list arrives
  // (e.g. a retired subject); drop it rather than send an id the server will reject.
  const offered = choices.some((s) => s.id === value);
  useEffect(() => {
    if (value !== null && !offered) onChange(null);
  }, [value, offered, onChange]);
  return (
    <fieldset className="upload-subject">
      <legend className="field-label">这份材料是哪一科？（可不选）</legend>
      <div className="chip-set">
        {choices.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`chip${!docxSelected && value === s.id ? ' is-on' : ''}`}
            aria-pressed={!docxSelected && value === s.id}
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
    </fieldset>
  );
}

/** The `subject_id` part of the create body: only a real choice, never an empty string. */
export function uploadSubjectField(subjectId: string | null): { subject_id?: string } {
  return subjectId ? { subject_id: subjectId } : {};
}
