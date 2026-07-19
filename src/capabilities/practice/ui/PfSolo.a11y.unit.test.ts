// YUK-718 — the immediate judge verdict (对/错 + AI 反馈) must be announced to AT.
// PfSolo only shows the verdict after a live judge round-trip (useQuery + judge
// mutation), which is impractical to drive in a unit render, so we assert the
// live-region wiring at the source level (same idiom as CopilotDock.quiz-chip).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('PfSolo verdict announcement (YUK-718)', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/capabilities/practice/ui/PfSolo.tsx'),
    'utf8',
  );
  // Anchor to the feedback verdict container (class pfs-fb) and read its open tag.
  const marker = source.indexOf('className={`pfs-fb v-${verdict.tone}`}');
  const verdictOpenTag = source.slice(marker, marker + 140);

  it('wraps the verdict card in a polite live region', () => {
    expect(marker).toBeGreaterThan(-1);
    expect(verdictOpenTag).toContain('aria-live="polite"');
  });
});
