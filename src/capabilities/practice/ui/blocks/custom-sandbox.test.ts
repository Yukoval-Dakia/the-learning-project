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
  const hex = bytesToHex(sha256(utf8(SAFE_CODE)));
  const rows: { name: string; bytes: Uint8Array; digests: string[]; expected: string | null }[] = [
    {
      name: 'digest mismatch',
      bytes: utf8(SAFE_CODE),
      digests: [digestOf(utf8(`${SAFE_CODE} `))],
      expected: null,
    },
    {
      name: 'unverified: digest',
      bytes: utf8(SAFE_CODE),
      digests: [`unverified:${hex}`, 'unverified:'],
      expected: null,
    },
    {
      name: 'malformed digest',
      bytes: utf8(SAFE_CODE),
      digests: [`sha256:${hex.toUpperCase()}`, `sha256:${hex.slice(0, 63)}`, hex, `SHA256:${hex}`],
      expected: null,
    },
    ...[
      { name: '</SCRIPT (uppercase)', bytes: utf8(`${SAFE_CODE}</SCRIPT><img src=x>`) },
      { name: '<!--', bytes: utf8(`${SAFE_CODE}<!--`) },
      { name: 'NUL', bytes: utf8(`${SAFE_CODE}\u0000`) },
      { name: 'invalid UTF-8', bytes: new Uint8Array([0xc3, 0x28]) },
    ].map((row) => ({ ...row, digests: [digestOf(row.bytes)], expected: null })),
    {
      name: 'compliant code (positive)',
      bytes: utf8(SAFE_CODE),
      digests: [digestOf(utf8(SAFE_CODE))],
      expected: SAFE_CODE,
    },
  ];

  // @invariant security: 只有与 digest 一致、内容合规的代码才会被注入
  // @fails-if any row's rule breaks: digest comparison dropped; `unverified:` treated as a bypass; non-canonical digest accepted (uppercase, wrong length, missing/uppercase prefix); `</SCRIPT` check made case-sensitive; `<!--` check removed; NUL check removed; non-fatal UTF-8 decoding; or compliant code rejected / returned altered
  it('injects only digest-matching, compliant code', () => {
    for (const row of rows) {
      for (const digest of row.digests) {
        expect(verifyCode(row.bytes, digest), row.name).toBe(row.expected);
      }
    }
  });
});

describe('shell and CSP', () => {
  const sources = SANDBOX_CSP.split(';').flatMap((directive) =>
    directive.trim().split(/\s+/).slice(1),
  );
  const head = buildShell(SAFE_CODE, 'draw').match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  const rows: { name: string; actual: unknown; expected: unknown }[] = [
    {
      name: "'unsafe-eval'",
      actual: SANDBOX_CSP.toLowerCase().includes('unsafe-eval'),
      expected: false,
    },
    { name: 'http: source', actual: sources.filter((s) => /^http:/i.test(s)), expected: [] },
    { name: 'https: source', actual: sources.filter((s) => /^https:/i.test(s)), expected: [] },
    { name: 'wildcard source', actual: sources.filter((s) => s.includes('*')), expected: [] },
    {
      name: "'self' source",
      actual: sources.filter((s) => s.toLowerCase() === "'self'"),
      expected: [],
    },
    {
      name: 'CSP meta first in head',
      actual: head.match(/^<[^>]*>/)?.[0],
      expected: `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    },
  ];

  // @invariant security: iframe 里的代码不能执行 eval，也连不了网
  // @fails-if any row's rule breaks: 'unsafe-eval' added to SANDBOX_CSP; an http:, https:, wildcard (*) or 'self' source added to any directive; or buildShell emits any element before the CSP meta in head
  it('frame code cannot eval or reach the network', () => {
    for (const row of rows) expect(row.actual, row.name).toEqual(row.expected);
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
  const wide = '字'.repeat(20000);
  // Every text is within its cap, but the UTF-8 bytes (3 per character) exceed 64 KiB.
  const wideMessage = messageWith({
    1: { ...VALID_ENTRIES[1], text: wide },
    2: { ...VALID_ENTRIES[2], text_md: wide },
  });
  const rows: { name: string; messages: unknown[] }[] = [
    {
      name: 'extra keys',
      messages: [
        messageWith({ 1: { ...VALID_ENTRIES[1], score: 1 } }),
        JSON.stringify({ type: 'response', entries: VALID_ENTRIES, correct: true }),
      ],
    },
    {
      name: 'state unknown',
      messages: [messageWith({ 0: { ...VALID_ENTRIES[0], state: 'unknown' } })],
    },
    {
      name: 'slot_id not in binds',
      messages: [
        messageWith({}, [
          { slot_id: 's_other', kind: 'select', state: 'answered', item_ids: ['a'] },
        ]),
      ],
    },
    {
      name: 'kind does not match bind',
      messages: [messageWith({ 1: { slot_id: 's_blank', kind: 'open', text_md: 'x' } })],
    },
    {
      name: 'item_id not in universe',
      messages: [messageWith({ 0: { ...VALID_ENTRIES[0], item_ids: ['a', 'zzz'] } })],
    },
    {
      name: 'duplicated item_id',
      messages: [messageWith({ 0: { ...VALID_ENTRIES[0], item_ids: ['c', 'c'] } })],
    },
    {
      name: 'at_most_per_coordinate broken',
      messages: [messageWith({ 0: { ...VALID_ENTRIES[0], item_ids: ['a', 'b'] } })],
    },
    {
      name: 'state blank with content',
      messages: [
        messageWith({ 0: { ...VALID_ENTRIES[0], state: 'blank' } }),
        messageWith({ 1: { ...VALID_ENTRIES[1], state: 'blank' } }),
      ],
    },
    {
      name: 'NUL',
      messages: [messageWith({ 2: { ...VALID_ENTRIES[2], text_md: 'a\u0000b' } })],
    },
    {
      name: 'lone surrogate',
      messages: [messageWith({ 1: { ...VALID_ENTRIES[1], text: 'x\uD800y' } })],
    },
    {
      name: 'bidi override',
      messages: [
        messageWith({ 2: { ...VALID_ENTRIES[2], text_md: `ok${String.fromCharCode(0x202e)}ko` } }),
      ],
    },
    {
      name: 'text over 20000 characters',
      messages: [messageWith({ 2: { ...VALID_ENTRIES[2], text_md: 'x'.repeat(20001) } })],
    },
    {
      name: 'not a string',
      messages: [JSON.parse(messageWith()), utf8(messageWith())],
    },
    {
      name: 'over 64 KiB',
      messages: [wideMessage, `${messageWith()}${' '.repeat(64 * 1024)}`],
    },
  ];

  // @invariant security: 块发来的消息只要有一处不合格，就整条拒收，不做部分应用
  // @fails-if any row's rule breaks, so the message is accepted in whole or in part: strict schema relaxed (extra entry/message keys stripped); state `unknown` accepted; slot outside the binds accepted; kind not checked against the bind; item_id outside the universe accepted; duplicate item_ids accepted; at_most_per_coordinate not enforced; blank state with content accepted; NUL, lone-surrogate or bidi checks removed; 20000-char text cap removed; non-string message parsed; 64 KiB cap dropped or measured in UTF-16 units; or a fully valid message rejected / altered
  it('rejects the whole message when any part is unacceptable', () => {
    expect(wideMessage.length, 'over 64 KiB').toBeLessThan(64 * 1024);
    for (const row of rows) {
      for (const message of row.messages) expect(validate(message), row.name).toBeNull();
    }
    expect(validate(messageWith()), 'valid message (positive)').toEqual(VALID_ENTRIES);
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
