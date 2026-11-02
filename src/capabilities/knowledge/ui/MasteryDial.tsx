// A small mastery dial (track + arc) for the knowledge pages, drawn in the M3E roles. It replaces
// the old shared MasteryRing (its only consumers were these pages). The tone still comes from
// masteryTone (the single 0.67 / 0.45 source), and null mastery still reads as 0 → 'again'.
// Decorative: the band and its words are carried by the BandChip beside it, so the dial is
// hidden from assistive tech (same as MasteryRing with showNumber=false).

import { masteryTone } from './mastery-tone';

export function MasteryDial({
  mastery,
  size = 30,
}: {
  /** 0-1 mastery; null / undefined = never practiced → 0. */
  mastery: number | null | undefined;
  size?: number;
}) {
  const m = Math.max(0, Math.min(1, mastery ?? 0));
  const tone = masteryTone(m);
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={`kn-dial tone-${tone}`}
      aria-hidden="true"
    >
      <circle className="kn-dial-track" cx={mid} cy={mid} r={r} fill="none" strokeWidth={3} />
      <circle
        className="kn-dial-arc"
        cx={mid}
        cy={mid}
        r={r}
        fill="none"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - m)}
        transform={`rotate(-90 ${mid} ${mid})`}
      />
    </svg>
  );
}
