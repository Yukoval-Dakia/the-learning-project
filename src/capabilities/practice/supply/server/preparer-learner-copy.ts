// Learner-authored material the preparer read (failure answer excerpts, cause notes and cause
// analyses) may decide the method and the errors a question targets, but must not reappear
// verbatim in a draft. Windows are whitespace-free so a reflowed copy still matches; text shorter
// than one window (e.g. a bare `x=2`) is too generic to tell a copy from a coincidence.

const LEARNER_TEXT_TOOLS = new Set([
  'query_mistakes',
  'query_knowledge',
  'expand_knowledge_subgraph',
]);
const LEARNER_TEXT_FIELDS = new Set(['excerpt', 'user_notes', 'analysis_md']);
export const LEARNER_COPY_WINDOW = 24;

const squash = (text: string) => text.replace(/\s+/g, '');

function strings(
  value: unknown,
  key: string | undefined,
  visit: (text: string, key?: string) => void,
) {
  if (typeof value === 'string') visit(value, key);
  else if (Array.isArray(value)) for (const item of value) strings(item, key, visit);
  else if (value !== null && typeof value === 'object')
    for (const [childKey, child] of Object.entries(value)) strings(child, childKey, visit);
}

/** Adds the learner-authored strings of one read result to `into`. */
export function collectLearnerText(toolName: string, output: unknown, into: Set<string>): void {
  if (!LEARNER_TEXT_TOOLS.has(toolName)) return;
  strings(output, undefined, (text, key) => {
    if (key === undefined || !LEARNER_TEXT_FIELDS.has(key)) return;
    const squashed = squash(text);
    if (squashed.length >= LEARNER_COPY_WINDOW) into.add(squashed);
  });
}

/** The first learner window found verbatim in a write's arguments, or null. */
export function findLearnerCopy(args: unknown, learnerText: ReadonlySet<string>): string | null {
  if (learnerText.size === 0) return null;
  const parts: string[] = [];
  strings(args, undefined, (text) => parts.push(squash(text)));
  // NUL is not whitespace, so no window spans two separate fields.
  const haystack = parts.join('\u0000');
  for (const text of learnerText)
    for (let start = 0; start + LEARNER_COPY_WINDOW <= text.length; start++) {
      const window = text.slice(start, start + LEARNER_COPY_WINDOW);
      if (haystack.includes(window)) return window;
    }
  return null;
}
