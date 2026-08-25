// @vitest-environment jsdom

// YUK-718 — MeshGraph's role="button" graph nodes handled Enter only. They now
// also activate on Space with preventDefault (native button semantics; the
// preventDefault stops Space from scrolling the page). Mirrors the QuestionsPage /
// DraftReviewPage idiom.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeTreeNode } from './knowledge-api';
import { MeshGraph } from './MeshGraph';

afterEach(cleanup);

function node(overrides: Partial<KnowledgeTreeNode> = {}): KnowledgeTreeNode {
  return {
    id: 'n1',
    name: '判断句',
    domain: 'yuwen',
    parent_id: null,
    effective_domain: 'yuwen',
    mastery: 0.5,
    mastery_lo: null,
    mastery_hi: null,
    low_confidence: false,
    evidence_count: 0,
    ...overrides,
  };
}

// The zoom controls are also role="button"; the graph node is the <g> carrying the
// mesh-node class (SVG element → read the class attribute, not classList).
function graphNode() {
  const found = screen
    .getAllByRole('button')
    .find((el) => (el.getAttribute('class') ?? '').includes('mesh-node'));
  expect(found).toBeTruthy();
  return found as Element;
}

describe('MeshGraph node keyboard activation (YUK-718)', () => {
  it('opens a node on Space and prevents the default page scroll', () => {
    const onPick = vi.fn();
    render(<MeshGraph nodes={[node()]} edges={[]} onPick={onPick} />);
    const notPrevented = fireEvent.keyDown(graphNode(), { key: ' ' });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }));
    expect(notPrevented).toBe(false); // dispatchEvent returns false ⇒ preventDefault fired
  });

  it('still opens a node on Enter', () => {
    const onPick = vi.fn();
    render(<MeshGraph nodes={[node()]} edges={[]} onPick={onPick} />);
    fireEvent.keyDown(graphNode(), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }));
  });

  it('wraps long CJK labels while retaining the full accessible name (YUK-897 F1)', () => {
    const fullName = '复合函数链式法则 E2E canary [B/C] 长文本';
    render(
      <MeshGraph nodes={[node({ id: 'long', name: fullName })]} edges={[]} onPick={vi.fn()} />,
    );

    const graph = graphNode();
    expect(graph.getAttribute('aria-label')).toBe(fullName);
    expect(graph.querySelector('title')?.textContent).toBe(fullName);
    expect(graph.querySelectorAll('tspan').length).toBeGreaterThan(1);
    const labelBackground = graph.querySelector('.mesh-node-label-bg');
    expect(Number(labelBackground?.getAttribute('width'))).toBeLessThanOrEqual(176);
    expect(Number(labelBackground?.getAttribute('height'))).toBeGreaterThan(20);
  });
});
