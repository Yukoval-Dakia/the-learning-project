export type SuggestionKind = 'proactive' | 'corrective';

export function SuggestionKindTag({ kind }: { kind?: SuggestionKind | null }) {
  if (kind !== 'corrective') return null;
  return (
    <span
      className="sug-kind sug-kind-corrective"
      title="suggestion_kind=corrective · 修正类建议不计入接受率"
    >
      修正
    </span>
  );
}
