// Unsent words and handoff ownership live only as long as this controller. Immutable entries
// distinguish a send's original draft from later edits, even when the words are identical.
import type { StoreApi } from 'zustand/vanilla';
import type { CompanionState } from './companion-state';

interface Draft {
  readonly text: string;
  readonly handed: string | null;
}

export interface DraftSend {
  clear: () => void;
  restore: () => boolean;
}

export type ConversationDrafts = ReturnType<typeof createConversationDrafts>;

export function createConversationDrafts(store: StoreApi<CompanionState>) {
  const drafts = new Map<string | null, Draft>();
  const empty = (): Draft => ({ text: '', handed: null });
  drafts.set(null, empty());

  function current(): Draft {
    const sessionId = store.getState().currentSessionId;
    let draft = drafts.get(sessionId);
    if (!draft) {
      draft = empty();
      drafts.set(sessionId, draft);
    }
    return draft;
  }

  function write(sessionId: string | null, draft: Draft) {
    drafts.set(sessionId, draft);
    if (store.getState().currentSessionId === sessionId) store.setState({ draft: draft.text });
  }

  function select(sessionId: string): Pick<CompanionState, 'currentSessionId' | 'draft'> {
    let draft = drafts.get(sessionId);
    if (!draft) {
      // Before the first selection, typed words and compose handoffs have no conversation yet.
      draft = store.getState().currentSessionId === null ? current() : empty();
      drafts.set(sessionId, draft);
    }
    drafts.delete(null);
    return { currentSessionId: sessionId, draft: draft.text };
  }

  function edit(text: string) {
    write(store.getState().currentSessionId, { text, handed: null });
  }

  function handoff(text: string) {
    const draft = current();
    const replace = draft.text.trim() === '' || draft.text === draft.handed;
    write(store.getState().currentSessionId, {
      text: replace ? text : `${draft.text}\n${text}`,
      handed: replace ? text : null,
    });
  }

  function captureSend(sessionId: string, raw: string): DraftSend {
    const original = drafts.get(sessionId);
    let cleared: Draft | undefined;
    return {
      clear() {
        if (!original || drafts.get(sessionId) !== original) return;
        if (original.text === raw) {
          cleared = empty();
          write(sessionId, cleared);
        } else if (original.text === '') {
          // Page prompts can be sent without ever occupying the composer.
          cleared = original;
        }
      },
      restore() {
        if (
          !cleared ||
          store.getState().currentSessionId !== sessionId ||
          drafts.get(sessionId) !== cleared
        )
          return false;
        write(sessionId, { text: raw, handed: null });
        cleared = undefined;
        return true;
      },
    };
  }

  return { select, edit, handoff, captureSend };
}
