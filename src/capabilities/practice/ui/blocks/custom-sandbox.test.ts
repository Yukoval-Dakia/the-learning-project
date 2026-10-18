// YUK-1497 — security-boundary checks for the custom block sandbox pure functions.
// Owner-approved plan (2026-10-18): tlp-status/discussions/custom-block-sandbox-test-plan.md.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import type { PresentationBindT } from '@/core/schema/assessment/presentation';
import {
  BlankSlot,
  type BlankSlotT,
  OpenResponseSlot,
  type ResponseSlotT,
  SelectSlot,
  type SelectSlotT,
  SlotResponse,
} from '@/core/schema/assessment/response';

import { SANDBOX_CSP, buildInit, buildShell, validateMessage, verifyCode } from './custom-sandbox';

const utf8 = (text: string) => new TextEncoder().encode(text);
const digestOf = (bytes: Uint8Array) => `sha256:${bytesToHex(sha256(bytes))}`;

const SAFE_CODE = 'globalThis.draw = function (port, init) { port.postMessage("{}"); };';

describe('verifyCode', () => {
  // @invariant security: 只有与 digest 一致、内容合规的代码才会被注入
  // @fails-if the digest comparison is dropped, so bytes whose sha256 differs from the digest are returned as code
  it('rejects code whose digest does not match', () => {
    const bytes = utf8(SAFE_CODE);
    expect(verifyCode(bytes, digestOf(utf8(`${SAFE_CODE} `)))).toBeNull();
  });

  // @invariant security: 只有与 digest 一致、内容合规的代码才会被注入
  // @fails-if an `unverified:` digest is treated as a bypass and the code is returned unchecked
  it('rejects an unverified: digest', () => {
    const bytes = utf8(SAFE_CODE);
    const hex = bytesToHex(sha256(bytes));
    expect(verifyCode(bytes, `unverified:${hex}`)).toBeNull();
    expect(verifyCode(bytes, 'unverified:')).toBeNull();
  });

  // @invariant security: 只有与 digest 一致、内容合规的代码才会被注入
  // @fails-if the digest format check or comparison accepts a non-canonical digest (uppercase hex, wrong length, missing prefix)
  it('rejects a malformed digest', () => {
    const bytes = utf8(SAFE_CODE);
    const hex = bytesToHex(sha256(bytes));
    expect(verifyCode(bytes, `sha256:${hex.toUpperCase()}`)).toBeNull();
    expect(verifyCode(bytes, `sha256:${hex.slice(0, 63)}`)).toBeNull();
    expect(verifyCode(bytes, hex)).toBeNull();
    expect(verifyCode(bytes, `SHA256:${hex}`)).toBeNull();
  });

  // @invariant security: 只有与 digest 一致、内容合规的代码才会被注入
  // @fails-if the closing-script check becomes case-sensitive, so `</SCRIPT` with a matching digest is injected and can end the shell's script early
  it('rejects code containing </SCRIPT (uppercase)', () => {
    const bytes = utf8(`${SAFE_CODE}</SCRIPT><img src=x>`);
    expect(verifyCode(bytes, digestOf(bytes))).toBeNull();
  });

  // @invariant security: 只有与 digest 一致、内容合规的代码才会被注入
  // @fails-if the `<!--` check is removed, so code with a matching digest can switch the parser's script state
  it('rejects code containing <!--', () => {
    const bytes = utf8(`${SAFE_CODE}<!--`);
    expect(verifyCode(bytes, digestOf(bytes))).toBeNull();
  });

  // @invariant security: 只有与 digest 一致、内容合规的代码才会被注入
  // @fails-if the NUL check is removed, so code with a matching digest containing U+0000 is injected
  it('rejects code containing NUL', () => {
    const bytes = utf8(`${SAFE_CODE}\u0000`);
    expect(verifyCode(bytes, digestOf(bytes))).toBeNull();
  });

  // @invariant security: 只有与 digest 一致、内容合规的代码才会被注入
  // @fails-if decoding is not fatal, so invalid UTF-8 with a matching digest is decoded with replacement characters and injected
  it('rejects bytes that are not valid UTF-8', () => {
    const bytes = new Uint8Array([0xc3, 0x28]);
    expect(verifyCode(bytes, digestOf(bytes))).toBeNull();
  });

  // @invariant security: 只有与 digest 一致、内容合规的代码才会被注入
  // @fails-if verification rejects compliant code or returns text other than the exact hashed buffer
  it('returns the exact text of compliant code with a matching digest', () => {
    const bytes = utf8(SAFE_CODE);
    expect(verifyCode(bytes, digestOf(bytes))).toBe(SAFE_CODE);
  });
});

describe('shell and CSP', () => {
  const sources = SANDBOX_CSP.split(';').flatMap((directive) =>
    directive.trim().split(/\s+/).slice(1),
  );

  // @invariant security: iframe 里的代码不能执行 eval，也连不了网
  // @fails-if 'unsafe-eval' is added to SANDBOX_CSP, letting frame code call eval/new Function
  it("SANDBOX_CSP does not contain 'unsafe-eval'", () => {
    expect(SANDBOX_CSP.toLowerCase()).not.toContain('unsafe-eval');
  });

  // @invariant security: iframe 里的代码不能执行 eval，也连不了网
  // @fails-if any directive gains an http: source (scheme or URL), letting frame code reach the network
  it('SANDBOX_CSP has no http: source', () => {
    expect(sources.filter((source) => /^http:/i.test(source))).toEqual([]);
  });

  // @invariant security: iframe 里的代码不能执行 eval，也连不了网
  // @fails-if any directive gains an https: source (scheme or URL), letting frame code reach the network
  it('SANDBOX_CSP has no https: source', () => {
    expect(sources.filter((source) => /^https:/i.test(source))).toEqual([]);
  });

  // @invariant security: iframe 里的代码不能执行 eval，也连不了网
  // @fails-if any directive gains a wildcard (*) source, letting frame code reach any host
  it('SANDBOX_CSP has no wildcard source', () => {
    expect(sources.filter((source) => source.includes('*'))).toEqual([]);
  });

  // @invariant security: iframe 里的代码不能执行 eval，也连不了网
  // @fails-if any directive gains a 'self' source, letting frame code reach the parent origin
  it("SANDBOX_CSP has no 'self' source", () => {
    expect(sources.filter((source) => source.toLowerCase() === "'self'")).toEqual([]);
  });

  // @invariant security: iframe 里的代码不能执行 eval，也连不了网
  // @fails-if buildShell emits any element before the CSP meta in head, so it runs before the policy applies
  it('buildShell puts the CSP meta first in head', () => {
    const html = buildShell(SAFE_CODE, 'draw');
    const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
    const first = head.match(/^<[^>]*>/)?.[0];
    expect(first).toBe(`<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`);
    expect(html.indexOf('<head>')).toBeLessThan(html.indexOf('<script'));
  });
});

// One select (with a one-to-one coordinate cap), one blank, one free bind; plus a slot that
// exists in the response spec but is not bound to this block.
const BINDS: PresentationBindT[] = [
  { unit_id: 'u1', slot_id: 's_sel', response_class: 'select' },
  { unit_id: 'u1', slot_id: 's_blank', response_class: 'blank' },
  { unit_id: 'u1', slot_id: 's_free', response_class: 'free' },
];
const SLOTS = new Map<string, ResponseSlotT>([
  [
    's_sel',
    SelectSlot.parse({
      slot_id: 's_sel',
      part_id: 'p1',
      kind: 'select',
      items: [
        { item_id: 'a', label_md: 'A', coordinates: { left: 'L1', right: 'R1' } },
        { item_id: 'b', label_md: 'B', coordinates: { left: 'L1', right: 'R2' } },
        { item_id: 'c', label_md: 'C', coordinates: { left: 'L2', right: 'R3' } },
      ],
      at_most_per_coordinate: { left: 1 },
    }),
  ],
  ['s_blank', BlankSlot.parse({ slot_id: 's_blank', part_id: 'p1', kind: 'blank' })],
  ['s_free', OpenResponseSlot.parse({ slot_id: 's_free', part_id: 'p1', kind: 'open_response' })],
  [
    's_other',
    SelectSlot.parse({
      slot_id: 's_other',
      part_id: 'p1',
      kind: 'select',
      items: [{ item_id: 'a', label_md: 'A' }],
    }),
  ],
]);

const VALID_ENTRIES = [
  { slot_id: 's_sel', kind: 'select', state: 'answered', item_ids: ['a', 'c'] },
  { slot_id: 's_blank', kind: 'blank', state: 'answered', text: '42' },
  { slot_id: 's_free', kind: 'open', text_md: 'because' },
];
/** A message made of the valid entries with `replace` swapped in by slot position. */
const messageWith = (replace: Record<number, unknown> = {}, extra: unknown[] = []) =>
  JSON.stringify({
    type: 'response',
    entries: [...VALID_ENTRIES.map((entry, i) => (i in replace ? replace[i] : entry)), ...extra],
  });
const validate = (data: unknown) => validateMessage(data, BINDS, SLOTS);

describe('validateMessage', () => {
  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if the strict schema is relaxed so unknown keys (on an entry or on the message) are stripped and the rest is applied
  it('rejects a message with extra keys', () => {
    expect(validate(messageWith({ 1: { ...VALID_ENTRIES[1], score: 1 } }))).toBeNull();
    expect(
      validate(JSON.stringify({ type: 'response', entries: VALID_ENTRIES, correct: true })),
    ).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if state `unknown` is accepted from the frame, letting it forge an illegible-handwriting state
  it('rejects state unknown', () => {
    expect(validate(messageWith({ 0: { ...VALID_ENTRIES[0], state: 'unknown' } }))).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if an entry for a slot outside this block's binds is accepted, letting the frame write another block's answer
  it('rejects a slot_id that is not in the binds', () => {
    expect(
      validate(
        messageWith({}, [
          { slot_id: 's_other', kind: 'select', state: 'answered', item_ids: ['a'] },
        ]),
      ),
    ).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if the entry kind is not checked against the bind's response class
  it('rejects a kind that does not match the bind', () => {
    expect(
      validate(messageWith({ 1: { slot_id: 's_blank', kind: 'open', text_md: 'x' } })),
    ).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if a select item_id outside the slot's public universe is accepted
  it('rejects an item_id that is not in the universe', () => {
    expect(
      validate(messageWith({ 0: { ...VALID_ENTRIES[0], item_ids: ['a', 'zzz'] } })),
    ).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if duplicate item_ids in one select entry are accepted
  it('rejects a duplicated item_id', () => {
    expect(validate(messageWith({ 0: { ...VALID_ENTRIES[0], item_ids: ['c', 'c'] } }))).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if at_most_per_coordinate is not enforced, so two items sharing left=L1 are accepted under a cap of 1
  it('rejects a selection that breaks at_most_per_coordinate', () => {
    expect(validate(messageWith({ 0: { ...VALID_ENTRIES[0], item_ids: ['a', 'b'] } }))).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if a blank state carrying content is accepted (select item_ids or blank text)
  it('rejects state blank that carries content', () => {
    expect(validate(messageWith({ 0: { ...VALID_ENTRIES[0], state: 'blank' } }))).toBeNull();
    expect(validate(messageWith({ 1: { ...VALID_ENTRIES[1], state: 'blank' } }))).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if the control-character check is removed, so text containing NUL is accepted
  it('rejects text containing NUL', () => {
    expect(validate(messageWith({ 2: { ...VALID_ENTRIES[2], text_md: 'a\u0000b' } }))).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if the lone-surrogate check is removed, so ill-formed UTF-16 text is accepted
  it('rejects text containing a lone surrogate', () => {
    expect(validate(messageWith({ 1: { ...VALID_ENTRIES[1], text: 'x\uD800y' } }))).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if the bidi check is removed, so text with a right-to-left override is accepted
  it('rejects text containing a bidi override', () => {
    expect(validate(messageWith({ 2: { ...VALID_ENTRIES[2], text_md: 'ok‮ko' } }))).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if the per-text cap of 20000 characters is removed or raised
  it('rejects text longer than 20000 characters', () => {
    expect(
      validate(messageWith({ 2: { ...VALID_ENTRIES[2], text_md: 'x'.repeat(20001) } })),
    ).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if a non-string message (structured-clone object) is parsed instead of rejected
  it('rejects a message that is not a string', () => {
    expect(validate(JSON.parse(messageWith()))).toBeNull();
    expect(validate(utf8(messageWith()))).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if the 64 KiB cap is dropped or measured in UTF-16 units instead of UTF-8 bytes
  it('rejects a message larger than 64 KiB', () => {
    // Every text is within its cap, but the UTF-8 bytes (3 per character) exceed 64 KiB.
    const wide = '字'.repeat(20000);
    const big = messageWith({
      1: { ...VALID_ENTRIES[1], text: wide },
      2: { ...VALID_ENTRIES[2], text_md: wide },
    });
    expect(big.length).toBeLessThan(64 * 1024);
    expect(validate(big)).toBeNull();
    expect(validate(`${messageWith()}${' '.repeat(64 * 1024)}`)).toBeNull();
  });

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if validation rejects a fully valid message or alters its entries
  it('accepts a valid message unchanged', () => {
    expect(validate(messageWith())).toEqual(VALID_ENTRIES);
  });
});

/** Every key and every slot_id value anywhere in the JSON tree. */
function walk(value: unknown, keys: Set<string>, slotIds: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, keys, slotIds);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      if (key === 'slot_id' && typeof child === 'string') slotIds.add(child);
      walk(child, keys, slotIds);
    }
  }
}

describe('buildInit', () => {
  // @invariant security: iframe 只能拿到本块绑定的那几个作答位和公开选项
  // @fails-if buildInit passes through another slot, item coordinates or an answer/grading field
  it('carries only the bound slots and public item fields', () => {
    const binds: PresentationBindT[] = [
      { unit_id: 'u1', slot_id: 's_sel', response_class: 'select' },
      { unit_id: 'u1', slot_id: 's_blank', response_class: 'blank' },
    ];
    // Runtime slots may be wider than the schema (rows carry answer/grading data); none may leak.
    const sel = SelectSlot.parse({
      slot_id: 's_sel',
      part_id: 'p1',
      kind: 'select',
      text: '甲乙丙丁',
      items: [
        { item_id: 'a', label_md: 'A', coordinates: { left: 'L1' }, gap_after_codepoint: 1 },
        { item_id: 'b', coordinates: { left: 'L2' } },
      ],
      axes: { left: [{ id: 'L1', label_md: 'left one' }] },
      at_most_per_coordinate: { left: 1 },
    });
    const slotById = new Map<string, ResponseSlotT>([
      [
        's_sel',
        {
          ...sel,
          answer_key: ['a'],
          items: sel.items.map((item) => ({ ...item, correct: item.item_id === 'a' })),
        } as SelectSlotT,
      ],
      [
        's_blank',
        {
          ...BlankSlot.parse({ slot_id: 's_blank', part_id: 'p1', kind: 'blank' }),
          answer: '42',
        } as BlankSlotT,
      ],
      [
        's_foreign',
        SelectSlot.parse({
          slot_id: 's_foreign',
          part_id: 'p1',
          kind: 'select',
          items: [{ item_id: 'foreign_item', label_md: 'FOREIGN_LABEL' }],
        }),
      ],
    ]);
    const entries = [
      { slot_id: 's_sel', kind: 'select', state: 'answered', item_ids: ['a'], self_confidence: 4 },
      { slot_id: 's_blank', kind: 'blank', state: 'answered', text: 'mine' },
      { slot_id: 's_foreign', kind: 'select', state: 'answered', item_ids: ['foreign_item'] },
      { slot_id: 's_foreign_open', kind: 'open', text_md: 'FOREIGN_TEXT' },
    ].map((entry) => SlotResponse.parse(entry));

    const init = buildInit(binds, slotById, entries, false);

    const keys = new Set<string>();
    const slotIds = new Set<string>();
    walk(init, keys, slotIds);
    const forbidden = [
      'coordinates',
      'gap_after_codepoint',
      'axes',
      'at_most_per_coordinate',
      'part_id',
      'answer_key',
      'answer',
      'correct',
      'self_confidence',
      'evidence',
      'score',
    ];
    expect(forbidden.filter((key) => keys.has(key))).toEqual([]);
    expect([...slotIds].sort()).toEqual(['s_blank', 's_sel']);
    const serialized = JSON.stringify(init);
    expect(serialized).not.toContain('FOREIGN');
    expect(serialized).not.toContain('foreign');
    expect(serialized).not.toContain('甲乙丙丁');

    // Non-vacuous: the bound universe and this block's own answers are present.
    expect(init.binds).toEqual([
      {
        slot_id: 's_sel',
        kind: 'select',
        items: [{ item_id: 'a', label_md: 'A' }, { item_id: 'b' }],
      },
      { slot_id: 's_blank', kind: 'blank' },
    ]);
    expect(init.entries).toEqual([
      { slot_id: 's_sel', kind: 'select', state: 'answered', item_ids: ['a'] },
      { slot_id: 's_blank', kind: 'blank', state: 'answered', text: 'mine' },
    ]);
  });
});
