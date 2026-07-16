import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LearningIntentComposer } from './LearningIntentComposer';

describe('LearningIntentComposer', () => {
  it('prefills the active goal and keeps confirmation in the proposal inbox', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <LearningIntentComposer initialTopic="系统掌握概率论" navigate={() => {}} />
      </QueryClientProvider>,
    );

    expect(html).toContain('系统掌握概率论');
    expect(html).toContain('生成学习路径');
    expect(html).toContain('只有你在收件箱确认后');
  });

  it('sends the owner to the inbox instead of offering duplicate generation', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <LearningIntentComposer pendingCount={1} navigate={() => {}} />
      </QueryClientProvider>,
    );

    expect(html).toContain('已有 1 条学习路径等待你确认');
    expect(html).toContain('去收件箱');
    expect(html).not.toContain('生成学习路径</button>');
  });
});
