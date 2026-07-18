import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CopilotDock quiz quick-chip', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/capabilities/copilot/ui/CopilotDock.tsx'),
    'utf8',
  );
  const sendQuizStart = source.indexOf('const sendQuiz = useCallback');
  const sendQuizEnd = source.indexOf('}, [focusedKnowledgeId, send]);', sendQuizStart);
  const sendQuizSource = source.slice(sendQuizStart, sendQuizEnd);
  const quizChipMarker = source.indexOf('data-testid="copilot-quiz-chip"');
  const quizChipSource = source.slice(quizChipMarker - 120, quizChipMarker + 320);

  it('keeps the prompt actionable without fabricating a knowledge context', () => {
    expect(quizChipSource).toContain('disabled={sending}');
    expect(quizChipSource).not.toContain('disabled={sending || !focusedKnowledgeId}');
    expect(sendQuizSource).not.toContain('if (!focusedKnowledgeId) return;');
    expect(sendQuizSource).toContain('activeSkillRef.current = null;');
    expect(sendQuizSource).toContain("void send('出题')");
  });

  it('shows knowledge scope in visible copy and does not rely on a hover-only reason', () => {
    expect(quizChipSource).toContain("{focusedKnowledgeId ? '出题 · 当前知识点' : '出题'}");
    expect(quizChipSource).not.toContain("'先选一个知识点'");
  });
});
