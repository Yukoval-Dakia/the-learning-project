// YUK-1512 — "how may this material be used?" choice on the upload screens.
// The choice rides the ingestion create request as `derivation_policy` (YUK-1408):
// the JSON session create and the Word multipart upload both accept it. Only
// 'answer_only' is sent; leaving it out means 'allow', the server default, so the
// default choice keeps today's request unchanged. The web never sends 'crisis'.
import { useId, useState } from 'react';

export type UploadUsagePolicy = 'allow' | 'answer_only';

const OPTIONS: readonly { value: UploadUsagePolicy; label: string; hint: string }[] = [
  {
    value: 'allow',
    label: '全部使用',
    hint: '这份资料也会用于长期记忆、学习总结等。',
  },
  {
    value: 'answer_only',
    label: '只用于本题',
    hint: '只用来生成这道题的答案和判分，不进记忆和总结；不影响做题和判分。',
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
    <fieldset className="upload-usage" disabled={disabled}>
      <legend className="field-label">这份资料可以用在哪里？</legend>
      {OPTIONS.map((o) => (
        <label key={o.value} className={`upload-usage-option${value === o.value ? ' is-on' : ''}`}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          <span className="upload-usage-text">
            <span className="upload-usage-label">{o.label}</span>
            <span className="upload-usage-hint">{o.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** The `derivation_policy` part of a create body: sent only for the restricted choice. */
export function uploadUsageField(policy: UploadUsagePolicy): {
  derivation_policy?: 'answer_only';
} {
  return policy === 'answer_only' ? { derivation_policy: 'answer_only' } : {};
}
