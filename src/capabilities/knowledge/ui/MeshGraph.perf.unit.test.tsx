// @vitest-environment jsdom

// YUK-717 — MeshGraph pan/zoom used to rebuild every node/edge element each frame
// (setView fires ~60/s and the node/edge maps were inlined under the transformed
// <g>). The fix memoizes the element arrays (deps = pos/nodes/edges/activeId/
// hasChildren/onPick, all view-independent) and wraps each node/edge in React.memo,
// so pan/zoom only mutates the parent <g> transform string — the node/edge subtrees
// are never re-rendered.
//
// Render-count probe: masteryTone() is called exactly once per MeshNode render, so
// its call count IS the MeshNode render count. We assert a zoom (wheel) and a pan
// (pointer drag) do NOT increase it, while a real input change (activeId) DOES.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeshGraph } from './MeshGraph';
import type { KnowledgeEdgeRow, KnowledgeTreeNode } from './knowledge-api';
import { masteryTone } from './mastery-tone';

// Wrap masteryTone in a spy while keeping its real implementation — the count is a
// faithful MeshNode-render counter.
vi.mock('./mastery-tone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mastery-tone')>();
  return { ...actual, masteryTone: vi.fn(actual.masteryTone) };
});

const masteryToneSpy = vi.mocked(masteryTone);

afterEach(() => {
  cleanup();
  masteryToneSpy.mockClear();
});

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

function edge(overrides: Partial<KnowledgeEdgeRow> = {}): KnowledgeEdgeRow {
  return {
    id: 'e1',
    from_knowledge_id: 'n1',
    to_knowledge_id: 'n2',
    relation_type: 'related_to',
    weight: 1,
    status: 'active',
    ...overrides,
  };
}

const NODES: KnowledgeTreeNode[] = [
  node({ id: 'n1', name: '父', parent_id: null }),
  node({ id: 'n2', name: '子', parent_id: 'n1', mastery: 0.8 }),
];
const EDGES: KnowledgeEdgeRow[] = [edge()];

// The main pan/zoom surface is the <svg role="img"> (legend svgs are aria-hidden).
function meshSvg(): SVGSVGElement {
  return screen.getByRole('img') as unknown as SVGSVGElement;
}

// The single direct-child <g> of the svg carries the pan/zoom transform; node/edge
// <g>s are nested inside it.
function transformGroup(svg: Element): Element {
  const g = svg.querySelector(':scope > g');
  expect(g).toBeTruthy();
  return g as Element;
}

describe('MeshGraph pan/zoom does not rebuild node/edge elements (YUK-717)', () => {
  it('leaves MeshNode render count unchanged across a zoom and a pan', () => {
    render(<MeshGraph nodes={NODES} edges={EDGES} onPick={vi.fn()} />);

    // Both nodes render once on mount.
    const afterMount = masteryToneSpy.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);

    const svg = meshSvg();
    const transformBefore = transformGroup(svg).getAttribute('transform');
    const edgeDBefore = svg.querySelector('.mesh-edge2')?.getAttribute('d');

    // Zoom: onWheel → setView → MeshGraph re-renders.
    fireEvent.wheel(svg, { deltaY: -120 });
    // Pan: pointer down then move → onPointerMove → setView → re-render again.
    fireEvent.pointerDown(svg, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(svg, { clientX: 40, clientY: 24 });
    fireEvent.pointerUp(svg);

    // Nodes were NOT re-rendered: masteryTone not called again.
    expect(masteryToneSpy.mock.calls.length).toBe(afterMount);

    // The view change landed on the parent <g> transform only…
    const transformAfter = transformGroup(svg).getAttribute('transform');
    expect(transformAfter).not.toBe(transformBefore);
    // …while the memoized edge geometry (positioned by layout, not view) is untouched.
    expect(svg.querySelector('.mesh-edge2')?.getAttribute('d')).toBe(edgeDBefore);
  });

  it('re-renders only the affected node when activeId changes — memo is precise, not frozen', () => {
    // Stable onPick across the rerender so activeId is the ONLY changed input.
    const onPick = vi.fn();
    const { rerender } = render(
      <MeshGraph nodes={NODES} edges={EDGES} onPick={onPick} activeId={null} />,
    );
    const afterMount = masteryToneSpy.mock.calls.length;

    rerender(<MeshGraph nodes={NODES} edges={EDGES} onPick={onPick} activeId="n1" />);

    // Only n1's isActive flips (null → active); n2's props are all unchanged so its
    // memo bails. Exactly one additional MeshNode render ⇒ +1 masteryTone call.
    expect(masteryToneSpy.mock.calls.length).toBe(afterMount + 1);
  });
});
