import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolUseCard } from './ToolUseCard';
import { COPILOT_TOOL_FIXTURES } from './copilot-tool-fixtures';

const sample = COPILOT_TOOL_FIXTURES[0];
if (!sample) throw new Error('expected at least one fixture');

describe('ToolUseCard 三段式', () => {
  it('renders tool name + summary + cost chip in head row', () => {
    const html = renderToString(
      <ToolUseCard
        toolName={sample.toolName}
        summary={sample.summary}
        costLabel={sample.costLabel}
        body={sample.body}
      />,
    );
    expect(html).toContain('data-testid="tool-use-card"');
    expect(html).toContain(`data-tool="${sample.toolName}"`);
    expect(html).toContain(sample.summary);
    expect(html).toContain(sample.costLabel);
    expect(html).toContain('data-testid="tool-use-toggle"');
  });

  it('keeps result body folded by default and expands when controlled', () => {
    const folded = renderToString(
      <ToolUseCard toolName={sample.toolName} summary={sample.summary} body={sample.body} />,
    );
    expect(folded).toContain('data-expanded="false"');
    expect(folded).not.toContain('data-testid="tool-use-body"');

    const expanded = renderToString(
      <ToolUseCard
        toolName={sample.toolName}
        summary={sample.summary}
        body={sample.body}
        expanded
      />,
    );
    expect(expanded).toContain('data-expanded="true"');
    expect(expanded).toContain('data-testid="tool-use-body"');
    expect(expanded).toContain(sample.body);
  });

  it('honours chainRowCost tweak by rendering cost detail row when "always-show"', () => {
    const summaryOnly = renderToString(
      <ToolUseCard
        toolName={sample.toolName}
        summary={sample.summary}
        costLabel={sample.costLabel}
        costDetail={sample.costDetail}
        chainRowCost="summary-only"
      />,
    );
    expect(summaryOnly).not.toContain('data-testid="tool-use-cost-row"');

    const alwaysShow = renderToString(
      <ToolUseCard
        toolName={sample.toolName}
        summary={sample.summary}
        costLabel={sample.costLabel}
        costDetail={sample.costDetail}
        chainRowCost="always-show"
      />,
    );
    expect(alwaysShow).toContain('data-testid="tool-use-cost-row"');
    expect(alwaysShow).toContain(sample.costDetail);
  });

  it('hides body + toggle when detailMode = "off"', () => {
    const off = renderToString(
      <ToolUseCard
        toolName={sample.toolName}
        summary={sample.summary}
        body={sample.body}
        detailMode="off"
        expanded
      />,
    );
    expect(off).toContain('data-expanded="false"');
    expect(off).not.toContain('data-testid="tool-use-toggle"');
    expect(off).not.toContain('data-testid="tool-use-body"');
  });
});
