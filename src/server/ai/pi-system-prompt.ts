// Single source for the pi system-prompt composition: the task base prompt plus
// SKILL.md bodies appended as <skill> blocks. pi has no filesystem skill loader,
// so resolvers hand bodies to the adapter and this is the only injection point.
// audit:copilot-prompt-budget measures this exact function.

export interface PiSkillDoc {
  readonly name: string;
  readonly body: string;
}

/** Append SKILL.md bodies; no docs and search available means byte-identical pass-through. */
export function composePiSystemPrompt(
  systemPrompt: string,
  skillDocs?: readonly PiSkillDoc[],
  searchUnavailable = false,
): string {
  const unavailable = searchUnavailable ? '\n网页搜索暂不可用，不得声称已搜过网页。' : '';
  if (!skillDocs || skillDocs.length === 0) return systemPrompt + unavailable;
  const docs = skillDocs
    .map((doc) => `<skill name="${doc.name}">\n${doc.body}\n</skill>`)
    .join('\n\n');
  return `${systemPrompt}\n\n${docs}${unavailable}`;
}
