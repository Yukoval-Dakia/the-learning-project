import { describe, expect, it } from 'vitest';
import { createCopilotProseStream, stripCopilotInternalComments } from './prose-stream';

describe('Copilot prose protocol filtering', () => {
  it.each([
    '题目：计算 17×19？\n答案：323。',
    '| Step | Result |\n| --- | --- |\n| 1 | 340 |\n| 2 | 323 |',
    '请证明 x²≥0，并解释等号条件。\nSolution: x=0。',
  ])('emits arbitrary learning prose immediately: %s', (text) => {
    const chunks: string[] = [];
    const stream = createCopilotProseStream((chunk) => chunks.push(chunk));
    stream.push(text);
    expect(chunks.join('')).toBe(text);
    stream.finish();
    expect(chunks.join('')).toBe(text);
  });

  it('hides marker JSON at every chunk boundary, including quoted HTML comments and escaped quotes', () => {
    const marker = `<!--primary_view:${JSON.stringify({ source: 'ephemeral_html', ref: '<section><!-- inner -->"answer --> still private"</section>' })}-->`;
    for (let split = 0; split <= marker.length; split += 1) {
      const chunks: string[] = [];
      const stream = createCopilotProseStream((text) => chunks.push(text));
      stream.push(`可见正文。${marker.slice(0, split)}`);
      expect(chunks.join('')).toBe('可见正文。');
      stream.push(`${marker.slice(split)}继续讲解。`);
      stream.finish();
      expect(chunks.join('')).toBe('可见正文。继续讲解。');
    }
  });

  it('discards an unfinished long protocol comment while preserving preceding prose', () => {
    const text = `答案：323。<!--copilot_learning_content:{"private":"${'长嵌套结构。'.repeat(4_000)}`;
    const chunks: string[] = [];
    const stream = createCopilotProseStream((chunk) => chunks.push(chunk));
    for (const char of text) stream.push(char);
    stream.finish();
    expect(chunks.join('')).toBe('答案：323。');
    expect(stripCopilotInternalComments(text)).toBe('答案：323。');
  });
});
