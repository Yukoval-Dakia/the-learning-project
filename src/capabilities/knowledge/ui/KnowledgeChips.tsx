// Small labels shared by the knowledge tree, the node drawer and the node detail page (M3E roles,
// styles in knowledge-m3e.css). Presentation only: callers pass the already-decided cue.
import { Check, CircleAlert, History, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RelationCue } from './relation-cue';

// The decay cue's icon names (decayCue / DECAY_BUCKET_META) → lucide glyphs. Icon + words carry
// the state, so the tone colour is never the only signal.
const DECAY_ICON: Record<string, ReactNode> = {
  check: <Check size={12} aria-hidden="true" />,
  alert: <CircleAlert size={12} aria-hidden="true" />,
  history: <History size={12} aria-hidden="true" />,
};

/** Memory / decay state: tone good / hard / again / neutral → positive / caution / critical / neutral. */
export function DecayChip({
  cue,
  label,
}: {
  cue: { label: string; icon: string; tone: string };
  /** Visible text; defaults to the cue's own label. */
  label?: string;
}) {
  return (
    <span className={`kn-tag kn-decay tone-${cue.tone}`}>
      {DECAY_ICON[cue.icon] ?? DECAY_ICON.history}
      {label ?? cue.label}
    </span>
  );
}

/** A typed relation: glyph + words; the colour follows the relation (kn-rel-tag-<type>). */
export function RelTag({ rel, cue }: { rel: string; cue: RelationCue }) {
  return (
    <span className={`kn-tag kn-rel-tag kn-rel-tag-${rel}`}>
      <span className="kn-glyph" aria-hidden="true">
        {cue.glyph}
      </span>
      {cue.label}
    </span>
  );
}

/** A note's verification state: 已校验 (positive) or 草稿 (neutral). */
export function VerifyChip({ verified }: { verified: boolean }) {
  if (verified) {
    return (
      <span className="kn-tag kn-tag-positive">
        <Check size={12} aria-hidden="true" />
        已校验
      </span>
    );
  }
  return (
    <span className="kn-tag">
      <Sparkles size={12} aria-hidden="true" />
      草稿
    </span>
  );
}
