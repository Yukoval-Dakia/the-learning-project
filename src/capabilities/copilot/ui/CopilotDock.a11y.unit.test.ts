// YUK-718 — the Copilot composer <textarea> had only a placeholder (not an
// accessible name). CopilotDock mounts stores / SSE / query wiring that make a
// full render heavy, so we assert the aria-label at the source level (same idiom
// as CopilotDock.quiz-chip.unit.test.ts).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CopilotDock composer accessible name (YUK-718)', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/capabilities/copilot/ui/CopilotDock.tsx'),
    'utf8',
  );
  const marker = source.indexOf('data-testid="copilot-composer-input"');
  // The composer <textarea> open tag lives just above the testid line.
  const composerTag = source.slice(marker - 220, marker + 40);

  it('gives the composer textarea an aria-label, not just a placeholder', () => {
    expect(marker).toBeGreaterThan(-1);
    expect(composerTag).toContain('<textarea');
    expect(composerTag).toContain('aria-label="问 Loom 任何事"');
  });
});
