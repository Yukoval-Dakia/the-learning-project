// The upload screen's two optional choices, in the M3E presentation (moved from
// src/ui/components/UploadSubjectPicker.tsx and UploadUsagePicker.tsx with their only consumer,
// YUK-1473; behaviour unchanged).
//
// YUK-1438 — "which subject is this material?". The chosen id rides the ingestion-session create
// request as `subject_id` (YUK-1404), so draft questions can render their subject's notation
// (e.g. math formulas) before anything is enrolled. Skippable: no choice sends nothing.
//
// YUK-1512 — "how may this material be used?". The choice rides the ingestion create request as
// `derivation_policy` (YUK-1408): the JSON session create and the Word multipart upload both
// accept it. Only 'answer_only' is sent; leaving it out means 'allow', the server default, so the
// default choice keeps the request unchanged. The web never sends 'crisis'.

import { Check } from 'lucide-react';
import { useId, useState } from 'react';
import { type ApiSubject, useSubjects } from '@/ui/hooks/useSubjects';
import { listSubjectChoices } from '@/ui/lib/subject';
import { ChipToggle } from '@/ui-next/public';

function uploadSubjectChoices(subjects: readonly ApiSubject[]) {
  // Unconfigured rows are raw knowledge domains with no subject profile; the server rejects
  // them as subject_id (400), which would fail an otherwise valid upload.
  return listSubjectChoices(subjects).filter((s) => s.configurationStatus !== 'unconfigured');
}

/**
 * The upload form's subject choice. Returns the choice only while the subject list still
 * offers it: a choice made on the first-frame builtin list may vanish when the real list
 * arrives (e.g. a retired subject), and then both the picker and the create request see
 * "no choice" instead of an id the server would reject. Use the returned value for both
 * display and the request body so they never disagree.
 */
export function useUploadSubjectChoice(): [string | null, (subjectId: string | null) => void] {
  const { subjects } = useSubjects();
  const [chosen, setChosen] = useState<string | null>(null);
  const offered = chosen !== null && uploadSubjectChoices(subjects).some((s) => s.id === chosen);
  return [offered ? chosen : null, setChosen];
}

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
  const choices = uploadSubjectChoices(subjects);
  return (
    <fieldset className="un-ob-field">
      <legend className="un-ob-hint">这份材料是哪一科？（可不选）</legend>
      <div className="un-ob-chips">
        {choices.map((s) => {
          const on = !docxSelected && value === s.id;
          return (
            <ChipToggle
              key={s.id}
              pressed={on}
              disabled={disabled || docxSelected}
              onPressedChange={() => onChange(value === s.id ? null : s.id)}
            >
              {on && <Check size={16} aria-hidden="true" />}
              {s.label}
            </ChipToggle>
          );
        })}
      </div>
      {docxSelected && (
        <p className="un-ob-hint">Word 文档暂时记不下科目，公式会先按普通文字显示。</p>
      )}
    </fieldset>
  );
}

/** The `subject_id` part of the create body: only a real choice, never an empty string. */
export function uploadSubjectField(subjectId: string | null): { subject_id?: string } {
  return subjectId ? { subject_id: subjectId } : {};
}

export type UploadUsagePolicy = 'allow' | 'answer_only';

const USAGE_OPTIONS: readonly { value: UploadUsagePolicy; label: string; hint: string }[] = [
  {
    value: 'allow',
    label: '全部使用',
    hint: '这份资料也会用于长期记忆、学习总结等。',
  },
  {
    value: 'answer_only',
    label: '只用于本题',
    hint: '只用来生成这道题的答案和判分，不会用于长期记忆和学习总结；不影响做题和判分。',
  },
];

export function useUploadUsageChoice(): [UploadUsagePolicy, (policy: UploadUsagePolicy) => void] {
  return useState<UploadUsagePolicy>('allow');
}

export function UploadUsagePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: UploadUsagePolicy;
  onChange: (policy: UploadUsagePolicy) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="un-ob-field" disabled={disabled}>
      <legend className="un-ob-hint">这份资料可以用在哪里？</legend>
      <div className="un-ob-usage">
        {USAGE_OPTIONS.map((o) => (
          <label
            key={o.value}
            className="un-ob-usage-option"
            data-on={value === o.value || undefined}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span className="un-ob-usage-text">
              <span className="un-ob-usage-label">{o.label}</span>
              <span className="un-ob-usage-hint">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The `derivation_policy` part of a create body: sent only for the restricted choice. */
export function uploadUsageField(policy: UploadUsagePolicy): {
  derivation_policy?: 'answer_only';
} {
  return policy === 'answer_only' ? { derivation_policy: 'answer_only' } : {};
}
