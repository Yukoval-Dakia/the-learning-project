// YUK-1497 — pure helpers for the custom (sandbox) block, spec §1.3. No React, no IO.
// The security review's approved design (custom-block-sandbox-plan v2) lives in these rules:
// - code integrity: one buffer is hashed (pure-JS SHA-256; the LAN deployment is plain http, so
//   there is no WebCrypto), compared to `sha256:<64 hex>`, decoded strictly and checked; that
//   same text is what the shell injects. Any failure keeps the block, and the question, closed.
// - the shell: string concatenation only (no String.replace, so no `$&` patterns), the CSP meta is
//   the first element, `entry` is only ever a JSON string used as a globalThis key.
// - messages: the frame only proposes. Each one is a string, size-capped, JSON-parsed, checked by
//   a strict schema and against this block's binds; one bad entry rejects the whole message.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';

import type {
  CustomBlockT,
  PresentationBindT,
  PresentationBlockT,
  PresentationT,
} from '@/core/schema/assessment/presentation';
import type { ResponseSlotT, SelectSlotT, SlotResponseT } from '@/core/schema/assessment/response';

import { readOpen, writeBlank, writeOpen, writeSelect } from './envelope';

/** Largest code asset the page will read (matches the publish gate). */
export const MAX_CODE_BYTES = 256 * 1024;
/** Largest message the page will read from the frame. */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** Anti-abuse cap per text; separate from the display-only `max_chars`. */
export const MAX_TEXT_CHARS = 20000;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ENTRY = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
// Besides NUL: anything that could end the shell's <script> early or switch the parser's script state.
const UNSAFE_CODE = /<\/script|<!--/i;

export function isValidDigest(digest: string): boolean {
  return DIGEST.test(digest);
}

export function isValidEntry(entry: string): boolean {
  return ENTRY.test(entry);
}

/**
 * The bytes as code, or null. `bytes` is the one buffer read from the server: it is hashed,
 * and only that same buffer is decoded into the text that will be injected.
 */
export function verifyCode(bytes: Uint8Array, digest: string): string | null {
  if (!isValidDigest(digest) || bytes.byteLength > MAX_CODE_BYTES) return null;
  if (`sha256:${bytesToHex(sha256(bytes))}` !== digest) return null;
  let code: string;
  try {
    code = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return code.includes('\u0000') || UNSAFE_CODE.test(code) ? null : code;
}

// default-src 'none' cuts every fetch, frame, worker and external script; no 'unsafe-eval'.
// base-uri and form-action do not fall back to default-src, so they are pinned.
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";

/**
 * The frame document. The bootstrap waits for the parent's one init message (it carries the
 * port), then calls `globalThis[entry](port, init)`. `code` must come from verifyCode and `entry`
 * must pass isValidEntry.
 */
export function buildShell(code: string, entry: string): string {
  const bootstrap =
    '(function(){var name=' +
    JSON.stringify(entry) +
    ';function onInit(e){if(e.source!==parent||!e.ports||!e.ports[0])return;' +
    "removeEventListener('message',onInit);var fn=globalThis[name];" +
    "if(typeof fn==='function')fn(e.ports[0],e.data);}" +
    "addEventListener('message',onInit);})();";
  return (
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="' +
    SANDBOX_CSP +
    '"><meta charset="utf-8"></head><body><script>' +
    bootstrap +
    '</script><script>' +
    code +
    '\n</script></body></html>'
  );
}

/** The custom blocks in the tree, in tree order. */
export function customBlocksOf(presentation: PresentationT): CustomBlockT[] {
  const out: CustomBlockT[] = [];
  const walk = (block: PresentationBlockT) => {
    if (block.kind === 'custom') out.push(block);
    else if (block.kind === 'stack' || block.kind === 'passage_layout')
      block.children.forEach(walk);
  };
  walk(presentation.root);
  return out;
}

/** Declared frame height; the frame itself can never change it. */
export function frameHeight(block: CustomBlockT): number {
  const declared = (block as { frame_height_px?: unknown }).frame_height_px;
  if (typeof declared !== 'number' || !Number.isInteger(declared)) return 320;
  return Math.min(720, Math.max(120, declared));
}

// ---------- parent → frame ----------

/** The slot kind each bind class must point at, and the entry kind it answers with. */
const SLOT_KIND = { select: 'select', blank: 'blank', free: 'open_response' } as const;
const ENTRY_KIND = { select: 'select', blank: 'blank', free: 'open' } as const;

type FrameEntry =
  | { slot_id: string; kind: 'select'; state: 'answered' | 'blank'; item_ids: string[] }
  | { slot_id: string; kind: 'blank'; state: 'answered' | 'blank'; text: string }
  | { slot_id: string; kind: 'open'; text_md: string };

/** The bound slot as issued, when it has the kind its bind declares. */
function boundSlot(
  bind: PresentationBindT,
  slotById: ReadonlyMap<string, ResponseSlotT>,
): ResponseSlotT | null {
  const slot = slotById.get(bind.slot_id);
  return slot?.kind === SLOT_KIND[bind.response_class] ? slot : null;
}

/**
 * The one init message: the binds with their public universes (item ids and labels only) and
 * this block's own current answers. No score, grading or correctness, and no other slot.
 */
export function buildInit(
  binds: readonly PresentationBindT[],
  slotById: ReadonlyMap<string, ResponseSlotT>,
  entries: readonly SlotResponseT[],
  locked: boolean,
) {
  const own: FrameEntry[] = [];
  for (const bind of binds) {
    const entry = entries.find((e) => e.slot_id === bind.slot_id);
    if (entry?.kind === 'select' && entry.state !== 'unknown') {
      own.push({
        slot_id: entry.slot_id,
        kind: 'select',
        state: entry.state,
        item_ids: [...entry.item_ids],
      });
    } else if (entry?.kind === 'blank' && entry.state !== 'unknown') {
      own.push({ slot_id: entry.slot_id, kind: 'blank', state: entry.state, text: entry.text });
    } else if (entry?.kind === 'open') {
      own.push({ slot_id: entry.slot_id, kind: 'open', text_md: entry.text_md });
    }
  }
  return {
    type: 'init' as const,
    locked,
    binds: binds.map((bind) => {
      const slot = boundSlot(bind, slotById);
      return {
        slot_id: bind.slot_id,
        kind: ENTRY_KIND[bind.response_class],
        ...(slot?.kind === 'select'
          ? {
              items: slot.items.map((item) => ({
                item_id: item.item_id,
                ...(item.label_md !== undefined ? { label_md: item.label_md } : {}),
              })),
            }
          : {}),
      };
    }),
    entries: own,
  };
}

// ---------- frame → parent ----------

const ProposedState = z.enum(['answered', 'blank']);
const ProposedEntry = z.discriminatedUnion('kind', [
  z
    .object({
      slot_id: z.string().min(1),
      kind: z.literal('select'),
      state: ProposedState,
      item_ids: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      slot_id: z.string().min(1),
      kind: z.literal('blank'),
      state: ProposedState,
      text: z.string(),
    })
    .strict(),
  z
    .object({
      slot_id: z.string().min(1),
      kind: z.literal('open'),
      text_md: z.string(),
    })
    .strict(),
]);
const ProposedMessage = z
  .object({ type: z.literal('response'), entries: z.array(ProposedEntry) })
  .strict();
export type ProposedEntryT = z.infer<typeof ProposedEntry>;

function textOk(text: string): boolean {
  return text.length <= MAX_TEXT_CHARS && !text.includes('\u0000') && text.isWellFormed();
}

function selectOk(slot: SelectSlotT, ids: readonly string[]): boolean {
  const universe = new Map(slot.items.map((item) => [item.item_id, item] as const));
  const picked = new Set<string>();
  for (const id of ids) {
    if (!universe.has(id) || picked.has(id)) return false;
    picked.add(id);
  }
  for (const [axis, limit] of Object.entries(slot.at_most_per_coordinate ?? {})) {
    const uses = new Map<string, number>();
    for (const id of picked) {
      const value = universe.get(id)?.coordinates?.[axis];
      if (value === undefined) continue;
      const count = (uses.get(value) ?? 0) + 1;
      if (count > limit) return false;
      uses.set(value, count);
    }
  }
  return true;
}

/**
 * The frame's proposed answers when every part of the message is acceptable; null rejects the
 * whole message (nothing is applied).
 */
export function validateMessage(
  data: unknown,
  binds: readonly PresentationBindT[],
  slotById: ReadonlyMap<string, ResponseSlotT>,
): ProposedEntryT[] | null {
  if (typeof data !== 'string' || data.length > MAX_MESSAGE_BYTES) return null;
  if (new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = ProposedMessage.safeParse(json);
  if (!parsed.success) return null;
  const bindBySlot = new Map(binds.map((bind) => [bind.slot_id, bind] as const));
  const seen = new Set<string>();
  for (const entry of parsed.data.entries) {
    const bind = bindBySlot.get(entry.slot_id);
    if (!bind || seen.has(entry.slot_id)) return null;
    seen.add(entry.slot_id);
    if (ENTRY_KIND[bind.response_class] !== entry.kind) return null;
    const slot = boundSlot(bind, slotById);
    if (!slot) return null;
    if (entry.kind === 'select') {
      if (slot.kind !== 'select' || !selectOk(slot, entry.item_ids)) return null;
      if (entry.state === 'blank' && entry.item_ids.length > 0) return null;
    } else if (entry.kind === 'blank') {
      if (!textOk(entry.text)) return null;
      if (entry.state === 'blank' && entry.text !== '') return null;
    } else if (!textOk(entry.text_md)) {
      return null;
    }
  }
  return parsed.data.entries;
}

/**
 * Apply validated answers through the envelope writers (draft rules: an empty answer is "not
 * answered"). Photos never come from the frame: an open answer keeps the slot's own evidence.
 */
export function applyProposed(
  prev: readonly SlotResponseT[],
  proposed: readonly ProposedEntryT[],
  slotById: ReadonlyMap<string, ResponseSlotT>,
): SlotResponseT[] {
  let out = [...prev];
  for (const entry of proposed) {
    if (entry.kind === 'select') {
      const slot = slotById.get(entry.slot_id);
      if (slot?.kind === 'select') out = writeSelect(out, slot, entry.item_ids);
    } else if (entry.kind === 'blank') {
      out = writeBlank(out, entry.slot_id, entry.text);
    } else {
      out = writeOpen(out, entry.slot_id, {
        text_md: entry.text_md,
        evidence: readOpen(out, entry.slot_id).evidence,
      });
    }
  }
  return out;
}

// ---------- 「你的作答」 ----------

const OPEN_SUMMARY_CHARS = 80;

/**
 * What the parent shows next to 提交 for the custom-bound slots, as plain text built from the
 * draft (only validated answers reach it). The frame cannot shape it.
 */
export function summarizeAnswers(
  binds: readonly PresentationBindT[],
  slotById: ReadonlyMap<string, ResponseSlotT>,
  entries: readonly SlotResponseT[],
): string[] {
  const out: string[] = [];
  for (const bind of binds) {
    const entry = entries.find((e) => e.slot_id === bind.slot_id);
    const slot = slotById.get(bind.slot_id);
    if (entry?.kind === 'select' && slot?.kind === 'select' && entry.item_ids.length > 0) {
      const labels = new Map(
        slot.items.map((item) => [item.item_id, item.label_md ?? item.item_id]),
      );
      out.push(entry.item_ids.map((id) => labels.get(id) ?? id).join('、'));
    } else if (entry?.kind === 'blank' && entry.text !== '') {
      out.push(entry.text);
    } else if (entry?.kind === 'open' && entry.text_md !== '') {
      const chars = [...entry.text_md];
      out.push(
        chars.length > OPEN_SUMMARY_CHARS
          ? `${chars.slice(0, OPEN_SUMMARY_CHARS).join('')}…`
          : entry.text_md,
      );
    }
  }
  return out;
}
