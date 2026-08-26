const INTERNAL_BRIEF_ID = /\b(?:copilot_user_ask|knowledge_mutation|event|kc)_[a-z0-9_-]+/i;

export function learnerGlobalBrief(raw: string | null | undefined): string | null {
  const brief = raw?.trim();
  if (!brief || INTERNAL_BRIEF_ID.test(brief)) return null;

  const latinCharacters = brief.match(/[A-Za-z]/g)?.length ?? 0;
  const cjkCharacters = brief.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return latinCharacters > Math.max(24, cjkCharacters * 2) ? null : brief;
}
