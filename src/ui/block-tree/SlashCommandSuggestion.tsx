'use client';

// YUK-150 P2-polish — `/`-triggered block-insert menu.
//
// A TipTap Suggestion (mature OSS, @tiptap/suggestion) mirroring the `@`
// cross_link picker (CrossLinkSuggestion.tsx): same imperative popup bridge
// (React root on document.body, fixed-positioned from the Suggestion
// clientRect, design-token styled, keyboard-driven through the editor's own
// keydown handler).
//
// On select, an `insert` item replaces the trigger range with a freshly-minted
// block node (new block id, ADR-0022). The `cross_link` item instead deletes
// the range and types `@`, re-triggering the existing cross_link picker (P5-A)
// rather than inserting an unanchored placeholder — no duplicated picker.

import { Extension } from '@tiptap/core';
import Suggestion, { type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';
import type { ReactNode } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { Icon } from '@/ui/primitives/Icon';
import { type SlashMenuItem, filterSlashMenuItems } from './slash-command-items';

// ── React popup list ──────────────────────────────────────────────────────

interface MenuListProps {
  items: SlashMenuItem[];
  query: string;
  activeIndex: number;
  onSelect: (item: SlashMenuItem) => void;
}

function MenuList({ items, query, activeIndex, onSelect }: MenuListProps): ReactNode {
  if (items.length === 0) {
    return (
      <div className="slash-menu">
        <div className="slash-menu-empty">{`无匹配「${query}」`}</div>
      </div>
    );
  }
  // No listbox/option ARIA roles — keyboard-driven through the editor's own
  // Suggestion keydown handler (Up/Down/Enter), matching CrossLinkSuggestion.
  return (
    <div className="slash-menu" aria-label="Insert block">
      {items.map((item, index) => (
        <button
          type="button"
          key={item.id}
          aria-current={index === activeIndex}
          className={`slash-menu-item${index === activeIndex ? ' is-active' : ''}`}
          // onMouseDown (not onClick) so the editor selection isn't lost first.
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(item);
          }}
        >
          <Icon name={item.kind === 'cross_link' ? 'link' : 'hash'} size={13} />
          <span className="slash-menu-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

// ── Popup controller (imperative bridge between Suggestion + React) ─────────

class MenuPopup {
  private el: HTMLDivElement | null = null;
  private root: Root | null = null;
  private items: SlashMenuItem[] = [];
  private query = '';
  private activeIndex = 0;
  private command: ((item: SlashMenuItem) => void) | null = null;
  private getRect: (() => DOMRect | null) | null | undefined = null;

  mount() {
    this.el = document.createElement('div');
    this.el.className = 'slash-menu-layer';
    document.body.appendChild(this.el);
    this.root = createRoot(this.el);
  }

  update(props: SuggestionProps<SlashMenuItem>) {
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
      <MenuList
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
    // its own render/commit lifecycle (Suggestion onExit can fire from one).
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

export function buildSlashCommandSuggestion(): Omit<SuggestionOptions<SlashMenuItem>, 'editor'> {
  return {
    char: '/',
    // Only trigger at the start of a block / after whitespace so `/` inside a
    // word (e.g. a path, a fraction) doesn't pop the menu.
    allowSpaces: false,
    startOfLine: false,
    command: ({ editor, range, props }) => {
      if (props.kind === 'cross_link') {
        // Delegate to the existing `@` cross_link picker (P5-A) rather than
        // duplicate it: drop the `/query` and type `@`.
        editor.chain().focus().deleteRange(range).insertContent('@').run();
        return;
      }
      const node = props.build();
      editor.chain().focus().deleteRange(range).insertContent(node).run();
    },
    items: ({ query }) => filterSlashMenuItems(query),
    render: () => {
      let popup: MenuPopup | null = null;
      return {
        onStart: (props) => {
          popup = new MenuPopup();
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

/** TipTap Extension wrapping the `/` block-insert Suggestion plugin. */
export function createSlashCommandSuggestionExtension() {
  return Extension.create({
    name: 'slashCommandSuggestion',
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashMenuItem>({
          editor: this.editor,
          ...buildSlashCommandSuggestion(),
        }),
      ];
    },
  });
}
