/**
 * The companion's state in its header (C1): "在这里" at rest, "在想…" while working. The words are
 * the source of truth; the mascot's spin only echoes them (B4).
 */
export function CompanionStatus({
  thinking,
  idleLabel = '在这里',
  thinkingLabel = '在想…',
}: {
  thinking: boolean;
  idleLabel?: string;
  thinkingLabel?: string;
}) {
  return (
    <span className="un-companion-state" data-thinking={thinking} aria-live="polite">
      {thinking ? thinkingLabel : idleLabel}
    </span>
  );
}
