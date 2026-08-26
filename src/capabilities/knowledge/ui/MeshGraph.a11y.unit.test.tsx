// @vitest-environment jsdom

// YUK-718 — MeshGraph's role="button" graph nodes handled Enter only. They now
// also activate on Space with preventDefault (native button semantics; the
// preventDefault stops Space from scrolling the page). Mirrors the QuestionsPage /
// DraftReviewPage idiom.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeshGraphNode } from './ghost-endpoints';
import { MeshGraph } from './MeshGraph';

afterEach(cleanup);

function node(overrides: Partial<MeshGraphNode> = {}): MeshGraphNode {
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

  it('announces a scoped graph crossing legend and styles its ghost endpoint', () => {
    const onPick = vi.fn();
    render(
      <MeshGraph
        nodes={[
          node(),
          node({
            id: 'math-node',
            name: '函数',
            domain: 'math',
            effective_domain: 'math',
            isGhost: true,
          }),
        ]}
        edges={[
          {
            id: 'cross-edge',
            from_knowledge_id: 'n1',
            to_knowledge_id: 'math-node',
            relation_type: 'related_to',
            weight: 1,
            status: 'active',
          },
        ]}
        onPick={onPick}
      />,
    );

    expect(screen.getByText('跨科连接 1')).toBeTruthy();
    expect(document.querySelector('.mesh-node.is-ghost')).toBeTruthy();
    expect(document.querySelector('.mesh-edge2.is-cross')).toBeTruthy();
  });

  it('does not show a crossing legend for the default all-subject graph', () => {
    render(<MeshGraph nodes={[node()]} edges={[]} onPick={vi.fn()} />);

    expect(screen.queryByText(/跨科连接/)).toBeNull();
  });
});
