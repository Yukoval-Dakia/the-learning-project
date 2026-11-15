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
  let creating: { sessionId: string | null; draft?: Draft } | null = null;
  const empty = (): Draft => ({ text: '', handed: null });
  drafts.set(null, empty());

  // The backing map can stay unchanged while pending edits own a newer draft version.
  function read(sessionId: string | null): Draft | undefined {
    return creating?.sessionId === sessionId && creating.draft
      ? creating.draft
      : drafts.get(sessionId);
  }

  function current(): Draft {
    const sessionId = store.getState().currentSessionId;
    let draft = read(sessionId);
    if (!draft) {
      draft = empty();
      drafts.set(sessionId, draft);
    }
    return draft;
  }

  function write(sessionId: string | null, draft: Draft) {
    drafts.set(sessionId, draft);
    if (
      store.getState().currentSessionId === sessionId &&
      !(creating?.sessionId === sessionId && creating.draft)
    )
      store.setState({ draft: draft.text });
  }

  function writeCurrent(draft: Draft) {
    const sessionId = store.getState().currentSessionId;
    if (creating && creating.sessionId === sessionId) {
      creating.draft = draft;
      store.setState({ draft: draft.text });
    } else {
      write(sessionId, draft);
    }
  }

  function finishCreate() {
    const pending = creating;
    creating = null;
    if (pending?.draft) write(pending.sessionId, pending.draft);
  }

  function select(sessionId: string): Pick<CompanionState, 'currentSessionId' | 'draft'> {
    finishCreate();
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
    writeCurrent({ text, handed: null });
  }

  function handoff(text: string) {
    const draft = current();
    const replace = draft.text.trim() === '' || draft.text === draft.handed;
    writeCurrent({
      text: replace ? text : `${draft.text}\n${text}`,
      handed: replace ? text : null,
    });
  }

  function captureCreate() {
    const pending: NonNullable<typeof creating> = {
      sessionId: store.getState().currentSessionId,
    };
    creating = pending;
    // Pending edits stay separate from the old draft, which an earlier send may still clear.
    return {
      select(sessionId: string) {
        if (creating === pending) {
          creating = null;
          if (pending.draft) drafts.set(sessionId, pending.draft);
        }
        return select(sessionId);
      },
      finish() {
        if (creating === pending) finishCreate();
      },
    };
  }

  function captureSend(sessionId: string, raw: string): DraftSend {
    const original = read(sessionId);
    let cleared: Draft | undefined;
    return {
      clear() {
        if (!original || read(sessionId) !== original) return;
        if (original.text === raw) {
          const next = empty();
          write(sessionId, next);
          // A pending draft shadows the map entry: clear reaches that draft so a refusal
          // restore does not land where finishCreate would overwrite it.
          cleared = creating?.sessionId === sessionId && creating.draft ? creating.draft : next;
        } else if (original.text === '') {
          // Page prompts can be sent without ever occupying the composer.
          cleared = creating?.sessionId === sessionId && creating.draft ? creating.draft : original;
        }
      },
      restore() {
        if (
          !cleared ||
          store.getState().currentSessionId !== sessionId ||
          read(sessionId) !== cleared
        )
          return false;
        const restored: Draft = { text: raw, handed: null };
        if (creating?.sessionId === sessionId && creating.draft) {
          // The visible box belongs to the pending draft: restore there, and the create's
          // select/finish carries the refused words instead of dropping them.
          creating.draft = restored;
          store.setState({ draft: restored.text });
        } else {
          write(sessionId, restored);
        }
        cleared = undefined;
        return true;
      },
    };
  }

  return { select, edit, handoff, captureCreate, captureSend };
}
