import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CopilotDock quiz quick-chip', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/capabilities/copilot/ui/CopilotDock.tsx'),
    'utf8',
  );

  it('keeps the prompt actionable without fabricating a knowledge context', () => {
    expect(source).toContain('disabled={sending}');
    expect(source).not.toContain('disabled={sending || !focusedKnowledgeId}');
    expect(source).not.toContain('if (!focusedKnowledgeId) return;');
    expect(source).toContain("void send('出题')");
  });

  it('shows knowledge scope in visible copy and does not rely on a hover-only reason', () => {
    expect(source).toContain("{focusedKnowledgeId ? '出题 · 当前知识点' : '出题'}");
    expect(source).not.toContain("'先选一个知识点'");
  });
});
