// Single source for the pi system-prompt composition: the task base prompt plus
// SKILL.md bodies appended as <skill> blocks. pi has no filesystem skill loader,
// so resolvers hand bodies to the adapter and this is the only injection point.
// audit:copilot-prompt-budget measures this exact function.

export interface PiSkillDoc {
  readonly name: string;
  readonly body: string;
}

/** Append SKILL.md bodies to the system prompt; no docs means byte-identical pass-through. */
export function composePiSystemPrompt(
  systemPrompt: string,
  skillDocs?: readonly PiSkillDoc[],
  searchUnavailable = false,
): string {
  const unavailable = searchUnavailable ? '\n搜索暂不可用，不得声称已搜索。' : '';
  if (!skillDocs || skillDocs.length === 0) return systemPrompt + unavailable;
  const docs = skillDocs
    .map((doc) => `<skill name="${doc.name}">\n${doc.body}\n</skill>`)
    .join('\n\n');
  return `${systemPrompt}\n\n${docs}${unavailable}`;
}
