// Shared client route builders (cross-capability UI layer, no capability boundary crossed —
// this mirrors how both knowledge/ and shell/ already import @/ui/lib/api).

/**
 * KC-scoped practice deep link (YUK-535): `/practice?kc=<id>` opens an on-demand scoped
 * practice session for one knowledge component. Single source of truth for the format so
 * the knowledge misconception cards (knowledge/ui/MisconceptionList) and the confirmed
 * teaching brief (shell/ui/TeachingBrief) can never drift. The knowledge id is passed to
 * `navigate()` only — it never lands in rendered DOM (teaching-brief contract §8.2).
 */
export function scopedPracticeHref(knowledgeId: string): string {
  return `/practice?kc=${encodeURIComponent(knowledgeId)}`;
}
