// ADR-0033 D5 (YUK-203) — static-HTML tests for the interactive artifact
// discovery section reused by the node detail page (.kd-main) and the graph node
// drawer (.drawer-sec). Pure presentational (resolved props only), so it is
// renderToString-tested on the node-only stack (no jsdom) — the page/drawer
// query containers are not unit-tested here (AutoEnrolledPanel PanelBody
// precedent). Pins: rows link to /notes/{id}, carry the .note-kind-interactive
// tag, and empty → renders nothing.

import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  InteractiveArtifactDiscovery,
  knowledgeBacklinkHref,
  knowledgeReviewRequest,
} from './KnowledgeDetailPage';
import type { NoteSummary } from './knowledge-api';

function artifact(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: 'art_1',
    type: 'interactive',
    title: '元素周期表 互动',
    knowledge_ids: ['k_1'],
    verification_status: 'verified',
    updated_at: '2026-06-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('InteractiveArtifactDiscovery', () => {
  it('renders each artifact as a /notes link row with the interactive tag', () => {
    const html = renderToString(
      <InteractiveArtifactDiscovery
        artifacts={[artifact(), artifact({ id: 'art_2', title: '电路 互动' })]}
        go={vi.fn()}
      />,
    );
    expect(html).toContain('元素周期表 互动');
    expect(html).toContain('电路 互动');
    // distinguished from note kinds by the interactive tag (reuses globals.css).
    expect(html).toContain('note-kind-interactive');
    // discovery rows reuse the note-link-row shape.
    expect(html).toContain('note-link-row');
    expect(html).toContain('互动');
    // updated_at is formatted via toLocaleDateString — assert the year shows
    // (TZ-robust: the UTC-midnight fixture is 2026-06-12/13 local, both contain 2026).
    expect(html).toContain('2026');
  });

  it('renders nothing when there are no interactive artifacts (no empty block)', () => {
    const html = renderToString(<InteractiveArtifactDiscovery artifacts={[]} go={vi.fn()} />);
    expect(html).toBe('');
  });
});

describe('knowledge surface action inventory', () => {
  it('opens shipped note readers and leaves unsupported artifact types non-clickable', () => {
    expect(knowledgeBacklinkHref('note_atomic', 'note_1', 'k_1')).toBe('/notes/note_1?entry=k_1');
    expect(knowledgeBacklinkHref('note_hub', 'note_2', 'k_1')).toBe('/notes/note_2?entry=k_1');
    expect(knowledgeBacklinkHref('interactive', 'art_1', 'k_1')).toBe('/notes/art_1?entry=k_1');
    expect(knowledgeBacklinkHref('learning_item', 'li_1', 'k_1')).toBeNull();
  });

  it('hands point review to Copilot with the exact knowledge name', () => {
    expect(knowledgeReviewRequest('判断句')).toBe(
      '请围绕知识点「判断句」安排一次针对性复习，并先说明你准备怎么做。',
    );
  });
});
