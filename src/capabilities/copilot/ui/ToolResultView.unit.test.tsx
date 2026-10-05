import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CopilotToolResultSnapshot, ToolResultJson } from '../primary-view-contract';
import { ToolResultView } from './ToolResultView';

function snapshot(value: ToolResultJson): CopilotToolResultSnapshot {
  return {
    version: 1,
    state: 'available',
    value,
    sha256: 'a'.repeat(64),
    byte_length: new TextEncoder().encode(JSON.stringify(value)).byteLength,
    completeness: 'complete',
    omissions: [],
  };
}

describe('saved Copilot result presentation', () => {
  it('renders actual evidence and falsy values, with inert markup and expandable structured details', () => {
    const html = renderToStaticMarkup(
      <ToolResultView
        toolName="query_knowledge"
        snapshot={snapshot({
          nodes: [{ name: '电磁感应', mastery: 0, evidence: null, approved: false, children: [] }],
          coverage: { has_more: false },
          text: '<img src="https://untrusted.invalid/pixel" onerror="alert(1)">',
        })}
      />,
    );
    expect(html).toContain('电磁感应');
    expect(html).toContain('>0<');
    expect(html).toContain('未知（null）');
    expect(html).toContain('否（false）');
    expect(html).toContain('无记录（0 项）');
    expect(html).toContain('<details');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('tuc-ribbon');
  });

  it('distinguishes historical absence, withheld content, bounded projection and genuine empty results', () => {
    const legacy = renderToStaticMarkup(<ToolResultView toolName="query_events" />);
    const withheld = renderToStaticMarkup(
      <ToolResultView
        toolName="query_events"
        snapshot={{ version: 1, state: 'unavailable', reason: 'internal_only' }}
      />,
    );
    const empty = renderToStaticMarkup(
      <ToolResultView toolName="query_events" snapshot={snapshot({ events: [], total: 0 })} />,
    );
    const projected = renderToStaticMarkup(
      <ToolResultView
        toolName="query_events"
        snapshot={{
          ...snapshot({ events: [] }),
          state: 'available',
          value: { events: [] },
          sha256: 'a'.repeat(64),
          byte_length: 13,
          completeness: 'projected',
          omissions: [{ path: '/events', reason: 'display_limit', omitted_count: 20 }],
        }}
      />,
    );
    expect(legacy).toContain('没有保存结果快照');
    expect(legacy).not.toContain('无记录');
    expect(withheld).toContain('不公开展示');
    expect(empty).toContain('无记录（0 项）');
    expect(empty).not.toContain('未包含');
    expect(projected).toContain('部分条目未包含');
  });
});
