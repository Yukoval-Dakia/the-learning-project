// CauseBadge — YUK-1020 secondary_labels 渲染契约（renderToString，无 DB）。
// 副标签 chip：`secondary` 裸 id 是 key/语义身份；`secondary_labels[id]` 命中
// 时渲染 title，缺席/未解析回退裸 id。primary 去重过滤不受影响。

import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CauseBadge } from './CauseBadge';

describe('CauseBadge secondary_labels', () => {
  it('renders the resolved title for misc_ secondary ids and falls back to raw ids', () => {
    const html = renderToString(
      <CauseBadge
        cause={{
          actor_kind: 'agent',
          primary: 'concept',
          secondary: ['misc_abc', 'grammar', 'misc_gone'],
          secondary_labels: { misc_abc: '虚词误判' },
          confidence: 0.8,
        }}
      />,
    );

    // React SSR 在 `+` 与文本间插 `<!-- -->` 分隔符，故按文本内容断言。
    expect(html).toContain('虚词误判</span>');
    expect(html).toContain('misc_gone</span>');
    expect(html).toContain('grammar</span>');
    // misc_abc 裸 id 不再渲染（被 title 替换）。
    expect(html).not.toContain('misc_abc');
  });

  it('renders raw secondary ids when secondary_labels is absent or null', () => {
    const html = renderToString(
      <CauseBadge
        cause={{
          actor_kind: 'agent',
          primary: 'concept',
          secondary: ['misc_abc'],
          secondary_labels: null,
        }}
      />,
    );
    expect(html).toContain('misc_abc</span>');
  });

  it('still filters secondary entries equal to primary', () => {
    const html = renderToString(
      <CauseBadge
        cause={{
          actor_kind: 'agent',
          primary: 'misc_pri',
          primary_label: '主因标题',
          secondary: ['misc_pri', 'misc_sec'],
          secondary_labels: { misc_sec: '副因标题' },
        }}
      />,
    );
    expect(html).toContain('副因标题</span>');
    // primary 同值副标签被过滤，不重复出现 misc_pri chip。
    expect(html).not.toContain('misc_pri</span>');
  });
});
