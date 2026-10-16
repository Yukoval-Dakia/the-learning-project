// YUK-1497 — host for a custom (sandbox) block, spec §1.3; design: custom-block-sandbox-plan v2
// (security review approved). The frame runs AI-written code in a null origin with no network.
//
// Loading: a useSyncExternalStore store, as useAssetObject does for assets — the first subscriber
// starts the read, the last one leaving drops it. The page fetches the code itself (never
// <script src>), once, capped at 256 KiB while streaming; that one buffer is hashed, checked and
// decoded (custom-sandbox.ts). Any failure shows a plain error and keeps the question closed.
//
// The frame: sandbox="allow-scripts" only, srcdoc only, fixed height. Its first load hands over
// one MessageChannel port, and the block is ready only once the shell's bootstrap answers 'ready'
// on it (within 3s, else it fails); any later load is the frame navigating itself, so it is
// blanked and the block fails. The page listens on that port only, never on window `message`. Everything the frame
// sends is a proposal: validated whole, then written through the envelope writers.
//
// Focus: the frame is inert until the learner starts it (click or the button); focus landing
// anywhere else on the page makes it inert again. All listeners live in ref callbacks.
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import type { CustomBlockT } from '@/core/schema/assessment/presentation';
import type { ResponseSlotT, SlotResponseT } from '@/core/schema/assessment/response';
import { apiFetch } from '@/ui/lib/api';

import {
  MAX_CODE_BYTES,
  applyProposed,
  buildInit,
  buildShell,
  frameHeight,
  isValidDigest,
  isValidEntry,
  validateMessage,
  verifyCode,
} from './custom-sandbox';
import type { EntriesUpdate } from './PresentationBlocks';

// ---------- code store ----------

type CodeState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'verified'; code: string; framed: boolean };

interface CodeEntry {
  refs: number;
  state: CodeState;
  abort: AbortController;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

/** How long a loaded frame has to answer with the shell's 'ready' before the block fails. */
const READY_TIMEOUT_MS = 3000;

const LOADING: CodeState = Object.freeze({ status: 'loading' });
const FAILED: CodeState = Object.freeze({ status: 'failed' });
const codeEntries = new Map<string, CodeEntry>();
const storeListeners = new Set<() => void>();

function publish(key: string, state: CodeState) {
  const entry = codeEntries.get(key);
  if (!entry || entry.state === state) return;
  entry.state = state;
  for (const listener of storeListeners) listener();
}

/** Readiness of a verified block's current frame (no-op for any other state). */
function setFramed(key: string, framed: boolean) {
  const state = codeEntries.get(key)?.state;
  if (state?.status === 'verified' && state.framed !== framed) publish(key, { ...state, framed });
}

/** One store entry per block and frozen code: navigation failures stay with that block. */
export function sandboxKey(block: CustomBlockT): string {
  const { asset, entry } = block.sandbox;
  return [block.block_id, asset.asset_id, asset.digest, entry].join('\u0000');
}

async function readCode(block: CustomBlockT, signal: AbortSignal): Promise<string | null> {
  const { asset, entry, contract } = block.sandbox;
  // Focus containment needs `inert` (older iPadOS lacks it): no inert, no block.
  if (!('inert' in HTMLElement.prototype)) return null;
  if (contract !== 'sandbox-v1' || !isValidDigest(asset.digest) || !isValidEntry(entry)) {
    return null;
  }
  const res = await apiFetch(`/api/assets/${encodeURIComponent(asset.asset_id)}/content`, {
    signal,
  });
  if (Number(res.headers.get('content-length') ?? 0) > MAX_CODE_BYTES || !res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CODE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return verifyCode(bytes, asset.digest);
}

function acquire(key: string, block: CustomBlockT, listener: () => void): () => void {
  storeListeners.add(listener);
  let entry = codeEntries.get(key);
  if (!entry) {
    const created: CodeEntry = {
      refs: 0,
      state: LOADING,
      abort: new AbortController(),
      releaseTimer: null,
    };
    codeEntries.set(key, created);
    entry = created;
    readCode(block, created.abort.signal).then(
      (code) => {
        if (codeEntries.get(key) !== created) return;
        publish(key, code === null ? FAILED : { status: 'verified', code, framed: false });
      },
      () => {
        if (codeEntries.get(key) === created) publish(key, FAILED);
      },
    );
  }
  const held = entry;
  held.refs += 1;
  if (held.releaseTimer) {
    clearTimeout(held.releaseTimer);
    held.releaseTimer = null;
  }
  return () => {
    storeListeners.delete(listener);
    held.refs -= 1;
    if (held.refs > 0 || held.releaseTimer) return;
    // One task later, so a same-commit remount keeps the verified code.
    held.releaseTimer = setTimeout(() => {
      held.releaseTimer = null;
      if (held.refs > 0 || codeEntries.get(key) !== held) return;
      held.abort.abort();
      codeEntries.delete(key);
      for (const l of storeListeners) l();
    }, 0);
  };
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

/**
 * True when every custom block given is verified, its current frame's shell has answered
 * 'ready', and nothing failed (load, handshake or navigation). No custom blocks: true. Never
 * starts a read itself.
 */
export function useCustomBlocksReady(blocks: readonly CustomBlockT[]): boolean {
  return useSyncExternalStore(
    subscribeStore,
    () =>
      blocks.every((block) => {
        const state = codeEntries.get(sandboxKey(block))?.state;
        return state?.status === 'verified' && state.framed;
      }),
    () => blocks.length === 0,
  );
}

// ---------- frame sessions ----------

/**
 * Per frame element: how many loads it has had, the page's end of its port, and whether the
 * shell's bootstrap has answered 'ready' on that port (proof the first load was our document).
 */
interface FrameSession {
  loads: number;
  port: MessagePort | null;
  ready: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
}

function closeSession(s: FrameSession) {
  if (s.readyTimer) clearTimeout(s.readyTimer);
  s.readyTimer = null;
  s.port?.close();
  s.port = null;
}
const sessions = new WeakMap<HTMLIFrameElement, FrameSession>();

// ---------- the block ----------

export interface CustomBlockProps {
  block: CustomBlockT;
  slotById: ReadonlyMap<string, ResponseSlotT>;
  entries: readonly SlotResponseT[];
  onEntriesChange: (update: EntriesUpdate, opts?: { immediate?: boolean }) => void;
  /** Submitting, submitted, read-only or otherwise not answering: the frame may not answer. */
  locked: boolean;
}

export function CustomBlock({
  block,
  slotById,
  entries,
  onEntriesChange,
  locked,
}: CustomBlockProps) {
  const key = sandboxKey(block);
  // `block` is read only when the entry is created; the key already covers what it reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on sandboxKey(block).
  const subscribe = useCallback((listener: () => void) => acquire(key, block, listener), [key]);
  const load = useSyncExternalStore(
    subscribe,
    () => codeEntries.get(key)?.state ?? LOADING,
    () => LOADING,
  );
  const code = load.status === 'verified' ? load.code : null;
  const entryName = block.sandbox.entry;
  const blockId = block.block_id;
  // Stable across re-renders and StrictMode, so the frame never reloads on its own.
  // biome-ignore lint/correctness/useExhaustiveDependencies: blockId keys the frame document too.
  const doc = useMemo(
    () => (code === null ? null : buildShell(code, entryName)),
    [code, entryName, blockId],
  );

  // A frame that was locked has closed its port; when answering resumes (e.g. a judge failed),
  // a fresh frame element takes over, with its own first load and port.
  const [lockSeen, setLockSeen] = useState(locked);
  const [frameGen, setFrameGen] = useState(0);
  if (lockSeen !== locked) {
    setLockSeen(locked);
    if (!locked) setFrameGen(frameGen + 1);
  }

  const [active, setActive] = useState(false);
  const attachStage = useCallback(
    (wrap: HTMLDivElement | null) => {
      if (!wrap || !active) return undefined;
      wrap.querySelector('iframe')?.focus();
      const owner = wrap.ownerDocument;
      const view = owner.defaultView;
      const outside = (event: Event) =>
        !(event.target instanceof Node) || !wrap.contains(event.target);
      const onFocusIn = (event: FocusEvent) => {
        if (outside(event)) setActive(false);
      };
      const onPointerDown = (event: PointerEvent) => {
        if (outside(event)) setActive(false);
      };
      // The window also blurs when focus moves into the frame; only leaving the page counts.
      let blurCheck: ReturnType<typeof setTimeout> | null = null;
      const onBlur = () => {
        if (blurCheck) clearTimeout(blurCheck);
        blurCheck = setTimeout(() => {
          blurCheck = null;
          if (!owner.hasFocus()) setActive(false);
        }, 0);
      };
      owner.addEventListener('focusin', onFocusIn);
      owner.addEventListener('pointerdown', onPointerDown);
      view?.addEventListener('blur', onBlur);
      return () => {
        owner.removeEventListener('focusin', onFocusIn);
        owner.removeEventListener('pointerdown', onPointerDown);
        view?.removeEventListener('blur', onBlur);
        if (blurCheck) clearTimeout(blurCheck);
      };
    },
    [active],
  );

  // Re-attached every render so the port handler and the init always use this render's props.
  const attachFrame = (frame: HTMLIFrameElement | null) => {
    if (!frame) return undefined;
    let session = sessions.get(frame);
    if (!session) {
      session = { loads: 0, port: null, ready: false, readyTimer: null };
      sessions.set(frame, session);
      // A new frame element (first mount, or the reload after an unlock) is not ready until its
      // own shell answers.
      setFramed(key, false);
    }
    const s = session;
    const onMessage = (event: MessageEvent) => {
      if (!s.port) return;
      // The bootstrap's fixed 'ready' comes first; nothing else counts before it, and after it
      // 'ready' is just an invalid message (not JSON).
      if (!s.ready) {
        if (event.data !== 'ready') return;
        s.ready = true;
        if (s.readyTimer) clearTimeout(s.readyTimer);
        s.readyTimer = null;
        setFramed(key, true);
        return;
      }
      if (locked) return;
      const proposed = validateMessage(event.data, block.binds, slotById);
      if (!proposed) return;
      onEntriesChange((prev) => applyProposed(prev, proposed, slotById), { immediate: true });
    };
    if (s.port) {
      if (locked) {
        s.port.postMessage({ type: 'lock' });
        closeSession(s);
      } else {
        s.port.onmessage = onMessage;
      }
    }
    const onLoad = () => {
      s.loads += 1;
      if (s.loads > 1) {
        // The frame navigated itself: cut it off, blank it once, and fail the block.
        closeSession(s);
        if (s.loads === 2) frame.srcdoc = '';
        publish(key, FAILED);
        return;
      }
      const channel = new MessageChannel();
      frame.contentWindow?.postMessage(buildInit(block.binds, slotById, entries, locked), '*', [
        channel.port2,
      ]);
      if (locked) {
        channel.port1.close();
        return;
      }
      channel.port1.onmessage = onMessage;
      s.port = channel.port1;
      // A load whose document is not our shell (e.g. replaced by about:blank) never answers.
      s.readyTimer = setTimeout(() => {
        s.readyTimer = null;
        if (s.ready) return;
        closeSession(s);
        publish(key, FAILED);
      }, READY_TIMEOUT_MS);
    };
    frame.addEventListener('load', onLoad);
    return () => {
      frame.removeEventListener('load', onLoad);
      // Unmounted (not just re-attached): close the page's end of the port.
      queueMicrotask(() => {
        if (!frame.isConnected) closeSession(s);
      });
    };
  };

  if (load.status === 'failed') {
    return <p className="un-blk-unsupported">这一部分加载异常，暂时不能在网页上作答。</p>;
  }

  return (
    <section className="un-blk-custom" aria-label="互动内容">
      <p className="un-blk-custom-note">下面这块互动内容由 AI 生成</p>
      <div className="un-blk-custom-stage" style={{ height: frameHeight(block) }}>
        {doc === null ? (
          <p className="un-blk-custom-wait">正在载入…</p>
        ) : (
          <>
            <div className="un-blk-custom-frame" inert={!active} ref={attachStage}>
              <iframe
                key={frameGen}
                ref={attachFrame}
                title="互动内容"
                sandbox="allow-scripts"
                allow=""
                referrerPolicy="no-referrer"
                srcDoc={doc}
              />
            </div>
            {!active && (
              <button type="button" className="un-blk-custom-start" onClick={() => setActive(true)}>
                <span className="un-blk-custom-start-chip un-glass">开始操作这一块</span>
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
