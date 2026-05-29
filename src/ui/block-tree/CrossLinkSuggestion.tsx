'use client';

// YUK-95 P5 Lane-A (Wave 7 D2/D3) — in-editor cross_link picker.
//
// An `@`-triggered TipTap Suggestion (mature OSS, @tiptap/suggestion) that
// fuzzy-searches artifacts by title and, on select, inserts a `crossLinkBlock`
// atom with FLAT attrs `{ id, artifact_id, block_id?, title }` (ADR-0022 / D3).
// This is the manual counterpart to Lane-C's nightly hub auto-sync. On save the
// existing editArtifactBodyBlocks → syncBlockRefsForArtifact (Lane-0) writes the
// artifact_block_ref L2 index — this file never touches the index (XC-3).
//
// We render the popup ourselves (no tippy / floating-ui dep): a fixed-position
// list positioned from the Suggestion `clientRect`, mounted into document.body
// via a lightweight React root, styled with design-system tokens.

import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';
import type { ReactNode } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { apiJson } from '@/ui/lib/api';
import { Icon } from '@/ui/primitives/Icon';
import {
  type ArtifactSearchResult,
  type CrossLinkPickerItem,
  buildCrossLinkInsertContent,
  mapSearchResultsToPickerItems,
} from './cross-link-picker';

export interface CrossLinkSuggestionContext {
  /** Artifact currently being edited; excluded from results to avoid self-links. */
  artifactId: string;
}

interface SearchResponse {
  rows: ArtifactSearchResult[];
}

async function fetchPickerItems(
  query: string,
  excludeArtifactId: string,
): Promise<CrossLinkPickerItem[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const params = new URLSearchParams({ q: trimmed, exclude: excludeArtifactId });
  try {
    const res = await apiJson<SearchResponse>(`/api/artifacts/search?${params.toString()}`);
    return mapSearchResultsToPickerItems(res.rows ?? []);
  } catch {
    return [];
  }
}

// ── React popup list ──────────────────────────────────────────────────────

interface PickerListProps {
  items: CrossLinkPickerItem[];
  query: string;
  activeIndex: number;
  onSelect: (item: CrossLinkPickerItem) => void;
}

function PickerList({ items, query, activeIndex, onSelect }: PickerListProps): ReactNode {
  if (items.length === 0) {
    return (
      <div className="cross-link-picker">
        <div className="cross-link-picker-empty">
          {query.trim().length === 0 ? '输入标题搜索 artifact…' : `无匹配「${query}」`}
        </div>
      </div>
    );
  }
  // No listbox/option ARIA roles: the list is keyboard-driven through the
  // editor's own Suggestion keydown handler (Up/Down/Enter), not native
  // listbox focus, and plain <button> entries already expose an actionable
  // accessible name. aria-current marks the highlighted entry.
  return (
    <div className="cross-link-picker" aria-label="Cross-link artifacts">
      {items.map((item, index) => (
        <button
          type="button"
          key={item.artifact_id}
          aria-current={index === activeIndex}
          className={`cross-link-picker-item${index === activeIndex ? ' is-active' : ''}`}
          // onMouseDown (not onClick) so the editor selection isn't lost first.
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(item);
          }}
        >
          <Icon name="link" size={13} />
          <span className="cross-link-picker-title">{item.title}</span>
          <span className="cross-link-picker-type">{item.type}</span>
        </button>
      ))}
    </div>
  );
}

// ── Popup controller (imperative bridge between Suggestion + React) ─────────

class PickerPopup {
  private el: HTMLDivElement | null = null;
  private root: Root | null = null;
  private items: CrossLinkPickerItem[] = [];
  private query = '';
  private activeIndex = 0;
  private command: ((item: CrossLinkPickerItem) => void) | null = null;
  private getRect: (() => DOMRect | null) | null | undefined = null;

  mount() {
    this.el = document.createElement('div');
    this.el.className = 'cross-link-picker-layer';
    document.body.appendChild(this.el);
    this.root = createRoot(this.el);
  }

  update(props: SuggestionProps<CrossLinkPickerItem>) {
    this.items = props.items;
    this.query = props.query;
    this.getRect = props.clientRect;
    this.command = (item) => props.command(item);
    if (this.activeIndex >= this.items.length) this.activeIndex = 0;
    this.render();
  }

  private render() {
    if (!this.root || !this.el) return;
    const rect = this.getRect?.();
    if (rect) {
      this.el.style.position = 'fixed';
      this.el.style.left = `${rect.left}px`;
      this.el.style.top = `${rect.bottom + 6}px`;
      this.el.style.zIndex = '60';
    }
    this.root.render(
      <PickerList
        items={this.items}
        query={this.query}
        activeIndex={this.activeIndex}
        onSelect={(item) => this.command?.(item)}
      />,
    );
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (this.items.length === 0) return false;
    if (event.key === 'ArrowDown') {
      this.activeIndex = (this.activeIndex + 1) % this.items.length;
      this.render();
      return true;
    }
    if (event.key === 'ArrowUp') {
      this.activeIndex = (this.activeIndex - 1 + this.items.length) % this.items.length;
      this.render();
      return true;
    }
    if (event.key === 'Enter') {
      const item = this.items[this.activeIndex];
      if (item) this.command?.(item);
      return true;
    }
    return false;
  }

  destroy() {
    // Defer unmount: React forbids unmounting a root synchronously while inside
    // its own render/commit lifecycle (the Suggestion onExit can fire from one).
    const root = this.root;
    const el = this.el;
    this.root = null;
    this.el = null;
    queueMicrotask(() => {
      root?.unmount();
      el?.remove();
    });
  }
}

// ── Extension ───────────────────────────────────────────────────────────────

export function buildCrossLinkSuggestion(
  context: CrossLinkSuggestionContext,
): Omit<SuggestionOptions<CrossLinkPickerItem>, 'editor'> {
  return {
    char: '@',
    // crossLinkBlock is an atom block, so replace the trigger range with a fresh
    // block-level node rather than inline content.
    command: ({ editor, range, props }) => {
      const node = buildCrossLinkInsertContent(props);
      editor.chain().focus().deleteRange(range).insertContent(node).run();
    },
    items: ({ query }) => fetchPickerItems(query, context.artifactId),
    render: () => {
      let popup: PickerPopup | null = null;
      return {
        onStart: (props) => {
          popup = new PickerPopup();
          popup.mount();
          popup.update(props);
        },
        onUpdate: (props) => {
          popup?.update(props);
        },
        onKeyDown: ({ event }) => {
          if (event.key === 'Escape') {
            popup?.destroy();
            popup = null;
            return true;
          }
          return popup?.onKeyDown(event) ?? false;
        },
        onExit: () => {
          popup?.destroy();
          popup = null;
        },
      };
    },
  };
}

/**
 * TipTap Extension wrapping the cross_link Suggestion plugin. Created per-editor
 * because it closes over the current `artifactId` (to exclude self-links).
 */
export function createCrossLinkSuggestionExtension(context: CrossLinkSuggestionContext) {
  return Extension.create({
    name: 'crossLinkSuggestion',
    addProseMirrorPlugins() {
      return [
        Suggestion<CrossLinkPickerItem>({
          editor: this.editor,
          ...buildCrossLinkSuggestion(context),
        }),
      ];
    },
  });
}
