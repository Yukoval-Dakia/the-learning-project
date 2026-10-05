import { describe, expect, it } from 'vitest';
import { layoutMeshLabel } from './label-layout';

describe('layoutMeshLabel', () => {
  it('wraps a long CJK label within a bounded label box', () => {
    const fullName = '复合函数链式法则 E2E canary [B/C] 长文本';
    const layout = layoutMeshLabel(fullName);

    expect(layout.fullName).toBe(fullName);
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.width).toBeLessThanOrEqual(layout.maxWidth);
    expect(layout.height).toBe(layout.lines.length * layout.lineHeight + layout.verticalPadding);
    expect(layout.lines.join('')).toContain('复合函数链式法则');
  });
});
